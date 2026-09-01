import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolsRoot, "..");
const sourceRoot = path.join(repositoryRoot, "webui", "src");
const catalogPath = path.join(sourceRoot, "i18n.jsx");
const baselinePath = path.join(toolsRoot, "i18n-baseline.json");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  }));
  return nested.flat();
}

function decodeDoubleQuoted(body) {
  return JSON.parse(`"${body}"`);
}

function placeholders(value) {
  return [...String(value).matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)]
    .map((match) => match[1])
    .sort();
}

const catalogSource = await readFile(catalogPath, "utf8");
const catalog = new Map();
for (const match of catalogSource.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,?\s*$/gm)) {
  const key = decodeDoubleQuoted(match[1]);
  const translation = decodeDoubleQuoted(match[2]);
  if (catalog.has(key)) {
    throw new Error(`Duplicate English translation key: ${key}`);
  }
  catalog.set(key, translation);
}

const used = new Map();
const sourceFiles = (await walk(sourceRoot)).filter((file) => /\.[cm]?[jt]sx?$/.test(file));
for (const file of sourceFiles) {
  const source = await readFile(file, "utf8");
  for (const match of source.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) {
    const key = decodeDoubleQuoted(match[1]);
    const files = used.get(key) ?? new Set();
    files.add(path.relative(repositoryRoot, file).replaceAll("\\", "/"));
    used.set(key, files);
  }
}

const missing = [];
const errors = [];
for (const [key, files] of [...used].sort(([left], [right]) => left.localeCompare(right))) {
  if (!catalog.has(key)) {
    missing.push({ key, files: [...files] });
    continue;
  }
  const expected = placeholders(key);
  const actual = placeholders(catalog.get(key));
  if (expected.join("\0") !== actual.join("\0")) {
    errors.push(
      `Placeholder mismatch for ${JSON.stringify(key)}: `
        + `expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
    );
  }
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
const missingKeys = missing.map((entry) => entry.key).sort();
const missingSha256 = createHash("sha256").update(missingKeys.join("\n"), "utf8").digest("hex");
if (baseline.missingCount !== missingKeys.length || baseline.sha256 !== missingSha256) {
  errors.push(
    `English translation debt changed: expected ${baseline.missingCount}/${baseline.sha256}, `
      + `found ${missingKeys.length}/${missingSha256}`,
  );
  errors.push(...missing.map((entry) => (
    `Missing English key ${JSON.stringify(entry.key)} (${entry.files.join(", ")})`
  )));
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `i18n check passed: ${used.size} literal UI keys, ${catalog.size} English entries, `
      + `${missingKeys.length} known untranslated keys pinned by baseline`,
  );
}
