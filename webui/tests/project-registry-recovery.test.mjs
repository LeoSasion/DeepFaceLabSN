import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectManager } from "../server/project-manager.mjs";
import { normalizeProjectName, normalizeProjectId, projectIdentityIssues } from "../shared/project-identity.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dfl-project-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = {
    registryRoot: path.join(root, "registry"), registryFile: path.join(root, "registry", "projects.json"),
    managedRoot: path.join(root, "workspaces"), legacyWorkspace: path.join(root, "legacy"),
  };
  await mkdir(options.legacyWorkspace, { recursive: true });
  return { ...options, manager: new ProjectManager(options) };
}

test("project creation uses the same normalized identity that the form previews", async t => {
  const { manager } = await fixture(t);
  const name = "  Interview    A  ";
  const id = "  Interview / A  ";
  const created = await manager.create({ name, id });
  assert.equal(created.name, normalizeProjectName(name));
  assert.equal(created.id, normalizeProjectId(id));
  assert.equal(path.basename(created.workspaceRoot), "interview-a");
  assert.equal((await manager.list()).activeId, "default", "creation does not change the current project");
  const issues = projectIdentityIssues(normalizeProjectName(name), normalizeProjectId(id), [created]);
  assert.equal(issues.id, "PROJECT_EXISTS");
  await assert.rejects(manager.create({ name, id: "INTERVIEW-A" }), error => error.code === issues.id);
});

test("reserved Windows directory names and empty normalized identifiers cannot be created", async t => {
  const { manager, managedRoot } = await fixture(t);
  for (const input of ["CON", "NUL", "COM1", "lpt9", "aux", "prn", "default", "///", "访谈"]) {
    const id = normalizeProjectId(input);
    assert.equal(projectIdentityIssues("Interview", id).id, "PROJECT_ID_INVALID");
    await assert.rejects(manager.create({ name: "Interview", id: input }), error => error.code === "PROJECT_ID_INVALID");
  }
  assert.equal(projectIdentityIssues("bad/name", "valid").name, "PROJECT_NAME_INVALID");
  assert.deepEqual(await readdir(managedRoot), []);
});

test("an unreadable project registry is preserved and project writes fail until it is repaired", async t => {
  const { manager, registryFile, managedRoot } = await fixture(t);
  await manager.create({ name: "Existing", id: "existing" });
  const original = await readFile(registryFile, "utf8");
  const registry = JSON.parse(original);
  const corruptions = [
    '{"projects":',
    JSON.stringify({ ...registry, projects: {} }),
    JSON.stringify({ ...registry, activeId: "missing" }),
    JSON.stringify({ ...registry, projects: [...registry.projects, registry.projects[1]] }),
    JSON.stringify({ ...registry, projects: [...registry.projects, { name: "Missing ID" }] }),
    JSON.stringify({ ...registry, projects: [...registry.projects, { id: "../outside" }] }),
  ];
  for (const contents of corruptions) {
    await writeFile(registryFile, contents);
    for (const action of [() => manager.list(), () => manager.create({ name: "New", id: "new" }), () => manager.activate("existing")]) {
      await assert.rejects(action(), error => error.code === "PROJECT_REGISTRY_UNREADABLE" && error.status === 500);
      assert.equal(await readFile(registryFile, "utf8"), contents);
    }
    assert.deepEqual(await readdir(managedRoot), ["existing"]);
  }
  await writeFile(registryFile, original);
  assert.equal((await manager.list()).projects.length, 2);
  await manager.activate("existing");
  assert.equal((await manager.list()).activeId, "existing");
});
