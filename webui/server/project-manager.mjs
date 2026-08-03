import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { PATHS, assertWithin, pathExists } from "./paths.mjs";

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const ACTIVE_JOB_STATES = new Set(["queued", "starting", "running", "waiting_input", "stopping"]);
const PROJECT_DIRECTORIES = ["data_src", "data_dst", "model", "xseg_model", ".webui"];

export class ProjectError extends Error {
  constructor(message, code = "PROJECT_ERROR", status = 400, details) {
    super(message);
    this.name = "ProjectError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function normalizeName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 64 || /[<>:"/\\|?*\u0000-\u001f]/.test(name)) {
    throw new ProjectError("项目名称需为 1–64 个安全字符", "PROJECT_NAME_INVALID");
  }
  return name;
}

function normalizeId(value) {
  const id = String(value ?? "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!PROJECT_ID.test(id) || id === "default") {
    throw new ProjectError("项目标识需由小写字母、数字和连字符组成", "PROJECT_ID_INVALID");
  }
  return id;
}

function defaultRegistry() {
  return {
    schemaVersion: 1,
    activeId: "default",
    projects: [{ id: "default", name: "默认项目", managed: false, createdAt: null }],
  };
}

function normalizeRegistry(value) {
  const fallback = defaultRegistry();
  const records = Array.isArray(value?.projects) ? value.projects : [];
  const projects = [fallback.projects[0]];
  const seen = new Set(["default"]);
  for (const record of records) {
    if (!PROJECT_ID.test(record?.id) || record.id === "default" || seen.has(record.id)) continue;
    seen.add(record.id);
    projects.push({
      id: record.id,
      name: typeof record.name === "string" && record.name.trim() ? record.name.trim().slice(0, 64) : record.id,
      managed: true,
      createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
    });
  }
  const activeId = seen.has(value?.activeId) ? value.activeId : "default";
  return { schemaVersion: 1, activeId, projects };
}

export class ProjectManager {
  constructor({
    registryRoot = PATHS.projectRegistryRoot,
    registryFile = PATHS.projectRegistryFile,
    managedRoot = PATHS.managedWorkspacesRoot,
    legacyWorkspace = path.join(PATHS.repositoryRoot, "workspace"),
  } = {}) {
    this.registryRoot = registryRoot;
    this.registryFile = registryFile;
    this.managedRoot = managedRoot;
    this.legacyWorkspace = legacyWorkspace;
  }

  async initialize() {
    await mkdir(this.registryRoot, { recursive: true });
    await mkdir(this.managedRoot, { recursive: true });
    if (!(await pathExists(this.registryFile))) await this.writeRegistry(defaultRegistry());
  }

  async readRegistry() {
    try {
      return normalizeRegistry(JSON.parse(await readFile(this.registryFile, "utf8")));
    } catch {
      return defaultRegistry();
    }
  }

  async writeRegistry(value) {
    const registry = normalizeRegistry(value);
    await mkdir(this.registryRoot, { recursive: true });
    const temporary = `${this.registryFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await rename(temporary, this.registryFile);
    return registry;
  }

  workspaceFor(id) {
    if (id === "default") return this.legacyWorkspace;
    if (!PROJECT_ID.test(id)) throw new ProjectError("项目标识无效", "PROJECT_ID_INVALID");
    return assertWithin(this.managedRoot, path.join(this.managedRoot, id), "项目工作区");
  }

  async list() {
    await this.initialize();
    const registry = await this.readRegistry();
    return {
      activeId: registry.activeId,
      projects: await Promise.all(registry.projects.map(async (project) => {
        const workspaceRoot = this.workspaceFor(project.id);
        return {
          ...project,
          active: project.id === registry.activeId,
          workspaceRoot,
          ready: await pathExists(workspaceRoot),
        };
      })),
    };
  }

  async create({ name, id } = {}) {
    await this.initialize();
    const safeName = normalizeName(name);
    const safeId = normalizeId(id || safeName);
    const registry = await this.readRegistry();
    if (registry.projects.some((project) => project.id === safeId)) {
      throw new ProjectError("项目标识已存在", "PROJECT_EXISTS", 409);
    }
    const workspaceRoot = this.workspaceFor(safeId);
    await Promise.all(PROJECT_DIRECTORIES.map((directory) => (
      mkdir(path.join(workspaceRoot, directory), { recursive: true })
    )));
    const record = {
      id: safeId,
      name: safeName,
      managed: true,
      createdAt: new Date().toISOString(),
    };
    await this.writeRegistry({ ...registry, projects: [...registry.projects, record] });
    return { ...record, active: false, ready: true, workspaceRoot };
  }

  async activate(id, jobs = []) {
    await this.initialize();
    if (!PROJECT_ID.test(id)) throw new ProjectError("项目标识无效", "PROJECT_ID_INVALID");
    const registry = await this.readRegistry();
    const project = registry.projects.find((candidate) => candidate.id === id);
    if (!project) throw new ProjectError("项目不存在", "PROJECT_MISSING", 404);
    const activeJobs = jobs.filter((job) => ACTIVE_JOB_STATES.has(job?.state));
    if (activeJobs.length) {
      throw new ProjectError(
        "切换项目前请先停止所有运行中任务",
        "PROJECT_BUSY",
        409,
        { jobIds: activeJobs.map((job) => job.id) },
      );
    }
    if (registry.activeId === id) return { ...project, changed: false, restartRequired: false };
    const workspaceRoot = this.workspaceFor(id);
    await Promise.all(PROJECT_DIRECTORIES.map((directory) => (
      mkdir(path.join(workspaceRoot, directory), { recursive: true })
    )));
    await this.writeRegistry({ ...registry, activeId: id });
    return { ...project, changed: true, restartRequired: true, workspaceRoot };
  }
}

export const projectManager = new ProjectManager();
