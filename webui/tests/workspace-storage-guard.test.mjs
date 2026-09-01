import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { importWorkspaceVideo } from "../server/workspace-manager.mjs";

const isolated = Boolean(process.env.DFLSN_ISOLATED_TEST_ROOT);

test("video import rejects known uploads before writing when the safety reserve would be crossed", {
  skip: isolated ? false : "requires the isolated generated workspace",
}, async () => {
  const request = Readable.from([Buffer.alloc(32)]);
  request.headers = { "content-length": "32" };

  await assert.rejects(
    importWorkspaceVideo("src", request, {
      encodedFileName: encodeURIComponent("replacement.mp4"),
      replace: true,
      inspectStorageFn: async (_root, { requiredBytes }) => ({
        ready: false,
        requiredBytes,
        usableBytes: 12,
        shortfallBytes: requiredBytes - 12,
        reserveBytes: 5 * 1024 ** 3,
      }),
    }),
    (error) => {
      assert.equal(error.code, "STORAGE_INSUFFICIENT");
      assert.equal(error.status, 507);
      assert.equal(error.details.requiredBytes, 32);
      assert.equal(error.details.usableBytes, 12);
      return true;
    },
  );
});
