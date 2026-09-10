export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const reservedDirectory = /^(?:default|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function normalizeProjectName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

export function normalizeProjectId(value) {
  return String(value ?? "").trim().toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

export function projectIdentityIssues(name, id, projects = []) {
  return {
    name: !name || name.length > 64 || /[<>:"/\\|?*\u0000-\u001f]/.test(name) ? "PROJECT_NAME_INVALID" : null,
    id: !PROJECT_ID_PATTERN.test(id) || reservedDirectory.test(id) ? "PROJECT_ID_INVALID"
      : projects.some(project => project.id.toLocaleLowerCase("en-US") === id) ? "PROJECT_EXISTS" : null,
  };
}
