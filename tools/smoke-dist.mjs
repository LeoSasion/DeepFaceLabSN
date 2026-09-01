import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolsRoot, "..");
const staticRoot = path.join(repositoryRoot, "webui", "dist", "client");
const indexPath = path.join(staticRoot, "index.html");

function contentType(target) {
  if (target.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (target.endsWith(".css")) return "text/css; charset=utf-8";
  if (target.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

const indexHtml = await readFile(indexPath, "utf8");
const referencedAssets = [...indexHtml.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)]
  .map((match) => match[1]);
if (!indexHtml.includes('id="root"') || referencedAssets.length === 0) {
  throw new Error("production index.html is incomplete");
}
for (const asset of referencedAssets) {
  const target = path.join(staticRoot, ...asset.split("/").filter(Boolean));
  const info = await stat(target).catch(() => null);
  if (!info?.isFile() || info.size === 0) throw new Error(`referenced asset is missing: ${asset}`);
}

const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/" || pathname === "/index.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(indexHtml);
      return;
    }
    if (!pathname.startsWith("/assets/") || pathname.includes("..")) {
      response.writeHead(404);
      response.end();
      return;
    }
    const target = path.join(staticRoot, ...pathname.split("/").filter(Boolean));
    const content = await readFile(target);
    response.writeHead(200, { "Content-Type": contentType(target) });
    response.end(content);
  } catch {
    response.writeHead(500);
    response.end();
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
try {
  const address = server.address();
  const rootResponse = await fetch(`http://127.0.0.1:${address.port}/`);
  if (rootResponse.status !== 200 || !(await rootResponse.text()).includes('id="root"')) {
    throw new Error("built WebUI root smoke request failed");
  }
  const assetResponse = await fetch(`http://127.0.0.1:${address.port}${referencedAssets[0]}`);
  if (assetResponse.status !== 200 || (await assetResponse.arrayBuffer()).byteLength === 0) {
    throw new Error("built WebUI asset smoke request failed");
  }
  console.log(`dist smoke passed: ${referencedAssets.length} referenced assets`);
} finally {
  await new Promise((resolve) => server.close(resolve));
}
