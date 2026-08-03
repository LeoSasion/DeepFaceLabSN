const ansiPattern = /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const oscPattern = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const iterationPattern =
  /\[#\s*(\d+)\]\[([^\]]+)\]\[(-?\d+(?:\.\d+)?)\]\[(-?\d+(?:\.\d+)?)\]/g;
const progressPattern =
  /^(.{0,160}?)\s*(\d{1,3})%\|[^|\r\n]*\|\s*([\d,]+)\s*\/\s*([\d,]+)\s*\[\s*([\d:]+|\?)\s*<\s*([\d:?]+)(?:,\s*([^\]]+))?\]/gm;

const promptPatterns = [
  /(?:请选择|选择一个|请输入|输入一个|是否|继续\?|确认\?|which .*?\?|choose .*?\?|enter .*?:)\s*$/i,
  /输入一个.+(?:[:：])\s*$/i,
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

function parseProgressTime(value) {
  const text = String(value ?? "").trim();
  if (!text || text.includes("?")) return null;
  const parts = text.split(":").map((part) => Number.parseInt(part, 10));
  if (!parts.length || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((seconds, part) => (seconds * 60) + part, 0);
}

function parseProgressNumber(value) {
  const number = Number.parseInt(String(value).replaceAll(",", ""), 10);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

const fatalPatterns = [
  { pattern: /ffmpeg fail/i, message: "DFL 内部 ffmpeg 执行失败" },
];

export function stripAnsi(value) {
  return String(value).replace(oscPattern, "").replace(ansiPattern, "");
}

export class OutputParser {
  #tail = "";
  #lastPrompt = "";
  #lastProgressSignature = "";

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

    const progressMatches = [...normalized.matchAll(progressPattern)];
    const progressMatch = progressMatches.at(-1);
    if (progressMatch) {
      const current = parseProgressNumber(progressMatch[3]);
      const total = parseProgressNumber(progressMatch[4]);
      const percent = Math.max(0, Math.min(100, Number.parseInt(progressMatch[2], 10)));
      const stage = progressMatch[1].replace(/:\s*$/, "").trim().slice(-120) || null;
      const elapsedSeconds = parseProgressTime(progressMatch[5]);
      const etaSeconds = parseProgressTime(progressMatch[6]);
      const rate = progressMatch[7]?.trim();
      // A percentage change is the useful UI cadence; per-item tqdm output can otherwise
      // double the terminal event volume for very large datasets.
      const signature = [stage, percent, total].join("|");
      if (current != null && total > 0 && signature !== this.#lastProgressSignature) {
        this.#lastProgressSignature = signature;
        events.push({
          type: "job.progress",
          payload: {
            stage,
            percent,
            current,
            total,
            elapsedSeconds,
            etaSeconds,
            rate: rate && !rate.includes("?") ? rate : null,
          },
        });
      }
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
