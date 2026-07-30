import { RuntimeServer } from "./app-server.mjs";

const port = Number.parseInt(process.env.DFL_WEBUI_PORT ?? "4174", 10);
const server = new RuntimeServer();

server.jobManager.on("warning", ({ message, error, jobId }) => {
  console.warn(`[runtime] ${message}${jobId ? ` (${jobId})` : ""}`, error ?? "");
});

const address = await server.start({
  host: "127.0.0.1",
  port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 4174,
});

console.log(`[runtime] DeepFaceLabSN Local Runtime listening on http://${address.host}:${address.port}`);

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[runtime] ${signal} received, closing HTTP/WebSocket listeners`);
  await server.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
