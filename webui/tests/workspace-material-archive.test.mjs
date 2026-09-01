import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { PATHS } from "../server/paths.mjs";
import {
  importWorkspaceVideo,
  listWorkspaceMaterialArchives,
  rollbackArchivedMaterial,
  restoreWorkspaceMaterial,
} from "../server/workspace-manager.mjs";

const isolated = Boolean(process.env.DFLSN_ISOLATED_TEST_ROOT);

function uploadRequest(bytes) {
  const request = Readable.from(bytes);
  request.headers = { "content-length": String(bytes.length) };
  return request;
}

test("failed material rollback preserves the archived recovery copy", async () => {
  let removalAttempted = false;
  await assert.rejects(
    rollbackArchivedMaterial({
      token: "20260901010101-1234567890",
      side: "src",
      archivedPath: "archive-copy.mp4",
      originalPath: "workspace-copy.mp4",
      directory: "archive-directory",
    }, {
      renameFile: async () => { throw new Error("simulated rename failure"); },
      removeDirectory: async () => { removalAttempted = true; },
    }),
    (error) => {
      assert.equal(error.code, "MATERIAL_ROLLBACK_FAILED");
      assert.deepEqual(error.details, {
        token: "20260901010101-1234567890",
        side: "src",
      });
      return true;
    },
  );
  assert.equal(removalAttempted, false);
});

test("material replacement is recoverable and every restore creates an undo archive", {
  skip: isolated ? false : "material archive mutation only runs inside the isolated workspace harness",
}, async () => {
  const originalPath = path.join(PATHS.workspaceRoot, "data_src.mp4");
  const replacementPath = path.join(PATHS.workspaceRoot, "data_src.mov");
  const original = await readFile(originalPath);
  const replacement = Buffer.from("DFLSN_REPLACEMENT_VIDEO");
  const imported = await importWorkspaceVideo("src", uploadRequest(replacement), {
    encodedFileName: encodeURIComponent("replacement.mov"),
    replace: true,
  });

  assert.match(imported.archiveToken, /^\d{14}-[a-f0-9]{10}$/);
  assert.deepEqual(await readFile(replacementPath), replacement);
  const archives = await listWorkspaceMaterialArchives("src");
  assert.ok(archives.some((archive) => archive.token === imported.archiveToken));

  const restored = await restoreWorkspaceMaterial("src", imported.archiveToken);
  assert.deepEqual(await readFile(originalPath), original);
  await assert.rejects(access(replacementPath));
  assert.match(restored.undoToken, /^\d{14}-[a-f0-9]{10}$/);

  const undo = await restoreWorkspaceMaterial("src", restored.undoToken);
  assert.deepEqual(await readFile(replacementPath), replacement);
  assert.match(undo.undoToken, /^\d{14}-[a-f0-9]{10}$/);
});
