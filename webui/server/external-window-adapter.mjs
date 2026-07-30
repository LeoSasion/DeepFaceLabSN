export class DisabledExternalWindowAdapter {
  capabilities() {
    return {
      supported: false,
      capture: false,
      input: false,
      embed: false,
      reason: "本轮仅预留外部窗口适配接口",
    };
  }

  async attach() {
    throw new Error("外部窗口适配器未启用");
  }

  async snapshot() {
    throw new Error("外部窗口适配器未启用");
  }

  async sendInput() {
    throw new Error("外部窗口适配器未启用");
  }

  async close() {
    return false;
  }
}
