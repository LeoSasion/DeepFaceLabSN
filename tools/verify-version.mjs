import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { releaseVersion as versionSource } from "../release/version.mjs";

const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolsRoot, "..");
const read = (relative) => readFile(path.join(repositoryRoot, relative), "utf8");

if (versionSource.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(versionSource.version)) {
  throw new Error("release/version.json is invalid");
}
if (!/^\d+\.\d+\.\d+$/.test(versionSource.nodeVersion)) {
  throw new Error("release/version.json has an invalid Node version");
}

const [assemblyInfo, channel, installer, launcherBat, webuiPackage, appServer] = await Promise.all([
  read("launcher/host/AssemblyInfo.cs"),
  read("launcher/update-channel.json").then(JSON.parse),
  read("webui/scripts/install-node.ps1"),
  read("启动 WebUI.bat"),
  read("webui/package.json").then(JSON.parse),
  read("webui/server/app-server.mjs"),
]);

const errors = [];
const assemblyVersion = `${versionSource.version}.0`;
if (!assemblyInfo.includes(`AssemblyVersion("${assemblyVersion}")`)) {
  errors.push(`launcher AssemblyVersion must be ${assemblyVersion}`);
}
if (!assemblyInfo.includes(`AssemblyFileVersion("${assemblyVersion}")`)) {
  errors.push(`launcher AssemblyFileVersion must be ${assemblyVersion}`);
}
if (channel.version !== versionSource.version) {
  errors.push(`launcher/update-channel.json version must be ${versionSource.version}`);
}
if (!installer.includes(`$NodeVersion = "${versionSource.nodeVersion}"`)) {
  errors.push(`install-node.ps1 must pin Node ${versionSource.nodeVersion}`);
}
if (!launcherBat.includes(`set "NODE_REQUIRED_VERSION=${versionSource.nodeVersion}"`)) {
  errors.push(`启动 WebUI.bat must pin Node ${versionSource.nodeVersion}`);
}
if (webuiPackage.packageManager !== `pnpm@${versionSource.pnpmVersion}`) {
  errors.push(`webui packageManager must be pnpm@${versionSource.pnpmVersion}`);
}
if (webuiPackage.engines?.node !== `>=${versionSource.nodeVersion.split(".")[0]} <${Number(versionSource.nodeVersion.split(".")[0]) + 1}`) {
  errors.push(`webui Node engine must cover only Node ${versionSource.nodeVersion.split(".")[0]}`);
}
if (/const\s+RUNTIME_VERSION\s*=\s*["']\d+\.\d+\.\d+["']/.test(appServer)) {
  errors.push("app-server runtime version must come from release/version.mjs, not a hard-coded string");
}
if (!appServer.includes('from "../../release/version.mjs"')
    || !appServer.includes("releaseVersion.version")) {
  errors.push("app-server must read its runtime version from release/version.mjs using a module-relative import");
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `version check passed: product ${versionSource.version}, Node ${versionSource.nodeVersion}, `
      + `pnpm ${versionSource.pnpmVersion}`,
  );
}
