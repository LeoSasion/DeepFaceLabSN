import { readFileSync } from "node:fs";

const versionUrl = new URL("./version.json", import.meta.url);

export const releaseVersion = Object.freeze(
  JSON.parse(readFileSync(versionUrl, "utf8")),
);
