import pty from "node-pty";

export class PtyProcessRunner {
  constructor({ executable, args, cwd, env, cols = 120, rows = 30 }) {
    this.closed = false;
    this.process = pty.spawn(executable, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
      useConpty: true,
    });
    this.pid = this.process.pid;
  }

  onData(listener) {
    return this.process.onData(listener);
  }

  onExit(listener) {
    return this.process.onExit(listener);
  }

  write(value) {
    this.process.write(value);
  }

  resize(cols, rows) {
    this.process.resize(cols, rows);
  }

  kill() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.process.kill();
    } catch {
      // The process may already be exiting.
    }
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    const agent = this.process._agent;
    if (agent) {
      try { agent._inSocket?.destroy(); } catch {}
      try { agent._outSocket?.destroy(); } catch {}
      try { agent._conoutSocketWorker?.dispose(); } catch {}
      try { this.process._close?.(); } catch {}
      return;
    }
    try { this.process.kill(); } catch {}
  }
}

export function createPtyRunner(options) {
  return new PtyProcessRunner(options);
}
