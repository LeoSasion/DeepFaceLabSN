import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { listCommands } from "../server/command-registry.mjs";

const origin = process.env.DFL_WEBUI_ORIGIN ?? "http://127.0.0.1:4173";
const socketOrigin = origin.replace(/^http/, "ws");

const healthResponse = await fetch(`${origin}/api/health`, {
  headers: { Origin: origin },
});
assert.equal(healthResponse.status, 200, "health endpoint should be reachable through the web origin");

const cookie = healthResponse.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie, "runtime should issue a loopback session cookie");

const healthPayload = await healthResponse.json();
assert.equal(healthPayload.ok, true, "runtime health payload should be successful");
assert.equal(healthPayload.data.capabilities.pty, true, "ConPTY capability should be available");
assert.equal(healthPayload.data.capabilities.trainerBridge, true, "Trainer bridge should be available");

const commandsResponse = await fetch(`${origin}/api/commands`, {
  headers: { Cookie: cookie, Origin: origin },
});
assert.equal(commandsResponse.status, 200, "commands endpoint should be reachable");
const commandsPayload = await commandsResponse.json();
assert.equal(commandsPayload.ok, true, "commands payload should be successful");
assert.equal(
  commandsPayload.data.length,
  listCommands().length,
  "live command catalog should match the fixed registry",
);

const workspaceResponse = await fetch(`${origin}/api/workspace`, {
  headers: { Cookie: cookie, Origin: origin },
});
assert.equal(workspaceResponse.status, 200, "workspace endpoint should be reachable");
const workspacePayload = await workspaceResponse.json();
assert.equal(workspacePayload.ok, true, "workspace payload should be successful");
assert.ok(Object.hasOwn(workspacePayload.data.materials, "src"), "workspace payload should describe SRC assets");
assert.ok(Object.hasOwn(workspacePayload.data.materials, "dst"), "workspace payload should describe DST assets");
assert.ok(Array.isArray(workspacePayload.data.models), "workspace payload should contain model groups");
assert.ok(Array.isArray(workspacePayload.data.outputs), "workspace payload should contain outputs");

const telemetryResponse = await fetch(`${origin}/api/telemetry`, {
  headers: { Cookie: cookie, Origin: origin },
});
assert.equal(telemetryResponse.status, 200, "telemetry endpoint should be reachable");
const telemetryPayload = await telemetryResponse.json();
assert.equal(telemetryPayload.ok, true, "telemetry payload should be successful");
assert.ok(Array.isArray(telemetryPayload.data.gpus), "telemetry payload should contain a GPU array");

const jobsResponse = await fetch(`${origin}/api/jobs`, {
  headers: { Cookie: cookie, Origin: origin },
});
assert.equal(jobsResponse.status, 200, "jobs endpoint should be reachable through the web origin");

const jobsPayload = await jobsResponse.json();
assert.equal(jobsPayload.ok, true, "jobs payload should be successful");
assert.ok(Array.isArray(jobsPayload.data), "jobs payload should contain an array");

if (jobsPayload.data.length) {
  const jobId = jobsPayload.data[0].id;
  const snapshot = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket snapshot timed out")), 5000);
    const webSocket = new WebSocket(
      `${socketOrigin}/ws?jobId=${encodeURIComponent(jobId)}`,
      { headers: { Cookie: cookie, Origin: origin } },
    );

    webSocket.once("message", (data) => {
      clearTimeout(timeout);
      webSocket.close();
      resolve(JSON.parse(data.toString()));
    });
    webSocket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  assert.equal(snapshot.type, "snapshot", "WebSocket should start with a job snapshot");
  assert.equal(snapshot.payload.id, jobId, "snapshot should match the selected job");
}

console.log(
  `live smoke passed: ${commandsPayload.data.length} commands, ${jobsPayload.data.length} jobs, `
    + `${telemetryPayload.data.gpus.length} GPUs, workspace/PTY/Trainer bridge available`,
);
