import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  mkdir,
  readFile,
  rmdir,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import {
  inspectQuarantinedAnnotation,
  listAlignedAssets,
  listAlignedQuarantine,
  resolveAlignedImage,
  resolveQuarantinedImage,
  restoreAlignedImage,
  streamAlignedImage,
  streamQuarantinedImage,
} from "../server/asset-manager.mjs";
import { PATHS, assertWithin, pathExists } from "../server/paths.mjs";

class ImageResponse extends Writable {
  constructor() {
    super();
    this.chunks = [];
    this.statusCode = null;
    this.headers = null;
  }

  writeHead(statusCode, headers) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  _write(chunk, _encoding, callback) {
    this.chunks.push(Buffer.from(chunk));
    callback();
  }
}

class FailingImageResponse extends Writable {
  constructor() {
    super();
    this.statusCode = null;
  }

  writeHead(statusCode) {
    this.statusCode = statusCode;
  }

  _write(_chunk, _encoding, callback) {
    callback(new Error("simulated response failure"));
  }
}

test("quarantine listing exposes real metadata and read-only image inspection", async (t) => {
  const assets = await listAlignedAssets("src", { offset: 0, limit: 200 });
  const fixture = assets.items.find((item) => item.hasDflMetadata);
  if (!fixture) {
    t.skip("workspace has no real SRC aligned fixture");
    return;
  }

  const token = `20990101000000-${randomBytes(5).toString("hex")}`;
  const quarantineRoot = assertWithin(
    PATHS.runtimeRoot,
    path.join(PATHS.runtimeRoot, "quarantine", "src"),
    "test quarantine root",
  );
  const tokenDirectory = assertWithin(
    quarantineRoot,
    path.join(quarantineRoot, token),
    "test quarantine token",
  );
  const quarantinedFile = assertWithin(
    tokenDirectory,
    path.join(tokenDirectory, fixture.name),
    "test quarantine file",
  );
  await mkdir(tokenDirectory, { recursive: true });
  await copyFile(
    resolveAlignedImage("src", encodeURIComponent(fixture.name)),
    quarantinedFile,
  );
  t.after(async () => {
    if (await pathExists(quarantinedFile)) await unlink(quarantinedFile);
    try {
      await rmdir(tokenDirectory);
    } catch {
      // Another test or runtime action may have populated this unique directory.
    }
  });

  const page = await listAlignedQuarantine("src", { offset: 0, limit: 200 });
  const item = page.items.find((candidate) => candidate.token === token);
  assert.ok(item);
  assert.equal(item.name, fixture.name);
  assert.equal(item.hasDflMetadata, true);
  assert.equal(
    item.imageUrl,
    `/api/assets/src/quarantine/${token}/${encodeURIComponent(fixture.name)}`,
  );
  const singleItemPage = await listAlignedQuarantine("src", { offset: 0, limit: 1 });
  assert.equal(singleItemPage.limit, 1);
  assert.equal(singleItemPage.total, page.total);
  assert.ok(singleItemPage.items.length <= 1);

  const before = await stat(quarantinedFile);
  const annotation = await inspectQuarantinedAnnotation(
    "src",
    token,
    encodeURIComponent(fixture.name),
  );
  const after = await stat(quarantinedFile);
  assert.ok(annotation.width > 0 && annotation.height > 0);
  assert.equal(annotation.landmarks.length, 68);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);

  const response = new ImageResponse();
  const finished = once(response, "finish");
  await streamQuarantinedImage(
    response,
    "src",
    token,
    encodeURIComponent(fixture.name),
  );
  await finished;
  assert.equal(response.statusCode, 200);
  assert.equal(Buffer.concat(response.chunks).length, before.size);
  assert.match(response.headers["Content-Type"], /^image\/(?:jpeg|png)$/);

  await assert.rejects(
    restoreAlignedImage("src", token, encodeURIComponent(fixture.name)),
    (error) => error.code === "RESTORE_CONFLICT" && error.status === 409,
  );
  assert.equal(await pathExists(quarantinedFile), true);
  await assert.rejects(
    resolveQuarantinedImage("src", "invalid", encodeURIComponent(fixture.name)),
    (error) => error.code === "QUARANTINE_TOKEN_INVALID",
  );
  await assert.rejects(
    resolveQuarantinedImage("src", token, encodeURIComponent("../escape.jpg")),
    (error) => error.code === "IMAGE_NAME_INVALID",
  );
});

test("quarantine resolver rejects symbolic-link files when the platform permits them", async (t) => {
  const assets = await listAlignedAssets("src", { offset: 0, limit: 1 });
  if (!assets.items.length) {
    t.skip("workspace has no SRC aligned fixture");
    return;
  }
  const token = `20990101000001-${randomBytes(5).toString("hex")}`;
  const tokenDirectory = assertWithin(
    PATHS.runtimeRoot,
    path.join(PATHS.runtimeRoot, "quarantine", "src", token),
    "test quarantine token",
  );
  const linkName = `link-${randomBytes(4).toString("hex")}.jpg`;
  const linkPath = assertWithin(tokenDirectory, path.join(tokenDirectory, linkName), "test link");
  await mkdir(tokenDirectory, { recursive: true });
  try {
    await symlink(
      resolveAlignedImage("src", encodeURIComponent(assets.items[0].name)),
      linkPath,
      "file",
    );
  } catch (error) {
    t.skip(`platform refused file symlink creation (${error.code || "unknown"})`);
    try {
      await rmdir(tokenDirectory);
    } catch {
      // Directory cleanup is best-effort after a platform-level skip.
    }
    return;
  }
  t.after(async () => {
    if (await pathExists(linkPath)) await unlink(linkPath);
    try {
      await rmdir(tokenDirectory);
    } catch {
      // The unique token directory is intentionally left alone if it is no longer empty.
    }
  });
  await assert.rejects(
    resolveQuarantinedImage("src", token, encodeURIComponent(linkName)),
    (error) => error.code === "QUARANTINE_PATH_UNSAFE",
  );
});

test("quarantine restore atomically installs a complete image without overwriting", async (t) => {
  const assets = await listAlignedAssets("src", { offset: 0, limit: 200 });
  const fixture = assets.items.find((item) => item.hasDflMetadata);
  if (!fixture) {
    t.skip("workspace has no real SRC aligned fixture");
    return;
  }
  const token = `20990101000002-${randomBytes(5).toString("hex")}`;
  const restoredName = `restored-${randomBytes(6).toString("hex")}.jpg`;
  const tokenDirectory = assertWithin(
    PATHS.runtimeRoot,
    path.join(PATHS.runtimeRoot, "quarantine", "src", token),
    "test quarantine token",
  );
  const quarantinedFile = assertWithin(
    tokenDirectory,
    path.join(tokenDirectory, restoredName),
    "test quarantine file",
  );
  const restoredFile = resolveAlignedImage("src", encodeURIComponent(restoredName));
  await mkdir(tokenDirectory, { recursive: true });
  await copyFile(
    resolveAlignedImage("src", encodeURIComponent(fixture.name)),
    quarantinedFile,
  );
  const expected = await readFile(quarantinedFile);
  t.after(async () => {
    if (await pathExists(quarantinedFile)) await unlink(quarantinedFile);
    if (await pathExists(restoredFile)) await unlink(restoredFile);
    try {
      await rmdir(tokenDirectory);
    } catch {
      // The unique token directory is intentionally left alone if it is no longer empty.
    }
  });

  const result = await restoreAlignedImage("src", token, encodeURIComponent(restoredName));
  assert.equal(result.restored, true);
  assert.equal(result.name, restoredName);
  assert.equal(await pathExists(quarantinedFile), false);
  assert.equal(await pathExists(restoredFile), true);
  assert.deepEqual(await readFile(restoredFile), expected);

  await assert.rejects(
    restoreAlignedImage("src", token, encodeURIComponent(restoredName)),
    (error) => error.code === "QUARANTINE_MISSING" && error.status === 404,
  );
});

test("aligned image streaming contains response failures instead of crashing the runtime", async (t) => {
  const assets = await listAlignedAssets("src", { offset: 0, limit: 1 });
  if (!assets.items.length) {
    t.skip("workspace has no SRC aligned fixture");
    return;
  }
  const response = new FailingImageResponse();
  await streamAlignedImage(
    response,
    "src",
    encodeURIComponent(assets.items[0].name),
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.destroyed, true);
});

test("aligned image streaming rejects directory junctions disguised as images", async (t) => {
  const linkName = `junction-${randomBytes(6).toString("hex")}.jpg`;
  const linkPath = resolveAlignedImage("src", encodeURIComponent(linkName));
  try {
    await symlink(PATHS.repositoryRoot, linkPath, "junction");
  } catch (error) {
    t.skip(`platform refused directory junction creation (${error.code || "unknown"})`);
    return;
  }
  t.after(async () => {
    if (await pathExists(linkPath)) await unlink(linkPath);
  });
  await assert.rejects(
    streamAlignedImage(new ImageResponse(), "src", encodeURIComponent(linkName)),
    (error) => error.code === "ALIGNED_PATH_UNSAFE" && error.status === 400,
  );
});
