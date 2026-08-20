import { parseCliArguments, startTerminalBridge } from "./terminal-bridge.mjs";

async function main() {
  let bridge;
  try {
    const options = parseCliArguments(process.argv.slice(2));
    bridge = await startTerminalBridge(options);
  } catch (error) {
    process.stderr.write(`ERROR ${JSON.stringify({
      code: "BRIDGE_START_FAILED",
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
    return;
  }

  // This is intentionally the first stdout line. The native host parses it.
  process.stdout.write(`READY ${JSON.stringify(bridge.ready)}\n`);

  const stop = () => { void bridge.close("process.signal"); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const result = await bridge.closed;
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  if (result.exit?.exitCode && Number.isInteger(result.exit.exitCode)) {
    process.exitCode = result.exit.exitCode;
  }
}

await main();
