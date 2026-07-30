import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CACHE_MS = 2500;
const QUERY_FIELDS = [
  "index",
  "name",
  "utilization.gpu",
  "memory.used",
  "memory.total",
  "temperature.gpu",
  "power.draw",
  "power.limit",
  "fan.speed",
];

let cached = null;
let cachedAt = 0;

function numberOrNull(value) {
  const number = Number.parseFloat(String(value).trim());
  return Number.isFinite(number) ? number : null;
}

export function parseNvidiaSmiCsv(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const values = line.split(",").map((value) => value.trim());
      return {
        index: Number.parseInt(values[0], 10),
        name: values[1] || "NVIDIA GPU",
        utilizationPercent: numberOrNull(values[2]),
        memoryUsedMiB: numberOrNull(values[3]),
        memoryTotalMiB: numberOrNull(values[4]),
        temperatureC: numberOrNull(values[5]),
        powerDrawW: numberOrNull(values[6]),
        powerLimitW: numberOrNull(values[7]),
        fanPercent: numberOrNull(values[8]),
      };
    })
    .filter((gpu) => Number.isInteger(gpu.index));
}

export async function getGpuTelemetry({ force = false } = {}) {
  if (!force && cached && Date.now() - cachedAt < CACHE_MS) return cached;
  try {
    const { stdout } = await execFileAsync("nvidia-smi.exe", [
      `--query-gpu=${QUERY_FIELDS.join(",")}`,
      "--format=csv,noheader,nounits",
    ], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 256 * 1024,
    });
    const gpus = parseNvidiaSmiCsv(stdout);
    cached = {
      available: gpus.length > 0,
      sampledAt: new Date().toISOString(),
      gpus,
      error: null,
    };
  } catch (error) {
    cached = {
      available: false,
      sampledAt: new Date().toISOString(),
      gpus: [],
      error: error?.code === "ENOENT"
        ? "未找到 nvidia-smi"
        : "GPU 遥测暂时不可用",
    };
  }
  cachedAt = Date.now();
  return cached;
}
