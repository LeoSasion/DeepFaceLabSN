import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  publicKeyId,
  signUpdateChannel,
  verifyUpdateChannel,
  verifyUpdateChannelPolicy,
} from "../update-channel-signature.mjs";

function manifest(version = "0.3.0") {
  return {
    schemaVersion: 1,
    version,
    publishedAt: "2026-08-31T00:00:00Z",
    sha256: "b".repeat(64),
    size: 2_448_384,
    sources: [{
      provider: "github",
      url: `https://github.com/LeoSasion/DeepFaceLabSN/releases/download/v${version}/launcher.exe`,
    }],
  };
}

test("Ed25519 channel signatures verify and reject payload tampering", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signed = signUpdateChannel(manifest(), privateKey);
  assert.equal(signed.signature.keyId, publicKeyId(publicKey));
  assert.equal(verifyUpdateChannel(signed, publicKey), true);
  assert.equal(verifyUpdateChannel({ ...signed, size: signed.size + 1 }, publicKey), false);
  assert.equal(verifyUpdateChannel({ ...signed, version: "0.3.1" }, publicKey), false);
});

test("signature policy accepts legacy releases and requires trusted future keys", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signed = signUpdateChannel(manifest(), privateKey);
  const publicKeySpkiBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const policy = {
    schemaVersion: 1,
    requiredFromVersion: "0.3.0",
    trustedKeys: [{ keyId: signed.signature.keyId, publicKeySpkiBase64 }],
  };
  assert.equal(verifyUpdateChannelPolicy(manifest("0.2.0"), policy).legacy, true);
  assert.throws(() => verifyUpdateChannelPolicy(manifest("0.3.0"), policy), /requires an Ed25519 signature/);
  assert.equal(verifyUpdateChannelPolicy(signed, policy).verified, true);
  assert.throws(
    () => verifyUpdateChannelPolicy(signed, { ...policy, trustedKeys: [] }),
    /not trusted/,
  );
});
