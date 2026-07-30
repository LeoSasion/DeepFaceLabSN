const ansiPattern = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const iterationPattern =
  /\[#\s*(\d+)\]\[([^\]]+)\]\[(-?\d+(?:\.\d+)?)\]\[(-?\d+(?:\.\d+)?)\]/g;

const promptPatterns = [
  /(?:请选择|选择一个|请输入|是否|继续\?|确认\?|which .*?\?|choose .*?\?|enter .*?:)\s*$/i,
  /\[(?:y\/n|Y\/n|y\/N)\]\s*$/i,
  /(?:\?:|：)\s*$/,
];

const ignoredPromptPatterns = [
  /按\s*Enter\s*(?:键)?停止训练/i,
  /press\s+enter\s+to\s+stop/i,
  /按\s*Space\s*可以切换视图/i,
];

function parseIterationTime(value) {
  const match = String(value).trim().match(/^([\d.]+)\s*(ms|s)$/i);
  if (!match) return null;
  const number = Number.parseFloat(match[1]);
  if (!Number.isFinite(number)) return null;
  return match[2].toLowerCase() === "s" ? number * 1000 : number;
}

const fatalPatterns = [
  { pattern: /ffmpeg fail/i, message: "DFL 内部 ffmpeg 执行失败" },
];

export function stripAnsi(value) {
  return String(value).replace(ansiPattern, "");
}

export class OutputParser {
  #tail = "";
  #lastPrompt = "";

  push(chunk) {
    const clean = stripAnsi(chunk).replaceAll("\0", "");
    this.#tail = `${this.#tail}${clean}`.slice(-6000);
    const normalized = this.#tail.replaceAll("\r", "\n");
    const lines = normalized.split("\n").filter(Boolean);
    const latest = lines.at(-1)?.trim() ?? "";
    const events = [];

    for (const fatal of fatalPatterns) {
      if (fatal.pattern.test(clean)) {
        events.push({
          type: "job.error",
          payload: { message: fatal.message },
        });
      }
    }

    for (const match of clean.matchAll(iterationPattern)) {
      events.push({
        type: "job.metric",
        payload: {
          iteration: Number.parseInt(match[1], 10),
          iterationTime: match[2],
          iterationTimeMs: parseIterationTime(match[2]),
          srcLoss: Number.parseFloat(match[3]),
          dstLoss: Number.parseFloat(match[4]),
        },
      });
    }

    const ignored = ignoredPromptPatterns.some((pattern) => pattern.test(latest));
    const isPrompt = !ignored && latest.length > 1 && promptPatterns.some((pattern) => pattern.test(latest));
    if (isPrompt && latest !== this.#lastPrompt) {
      this.#lastPrompt = latest;
      events.push({ type: "terminal.prompt", payload: { prompt: latest.slice(-500) } });
    } else if (!isPrompt && clean.trim()) {
      this.#lastPrompt = "";
    }

    return events;
  }
}
