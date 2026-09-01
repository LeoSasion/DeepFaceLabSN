import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const toolsRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolsRoot, "..");
const defaultManifest = path.join(repositoryRoot, "launcher", "update-channel.json");
const defaultPolicy = path.join(repositoryRoot, "launcher", "update-signing-policy.json");

function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("manifest contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalize(value[key])}`
    )).join(",")}}`;
  }
  throw new Error(`manifest contains an unsupported value: ${typeof value}`);
}

function unsignedManifest(manifest) {
  const { signature: _signature, ...payload } = manifest;
  return payload;
}

function signingBytes(manifest) {
  return Buffer.from(canonicalize(unsignedManifest(manifest)), "utf8");
}

function publicKeyDer(publicKey) {
  const key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  return key.export({ type: "spki", format: "der" });
}

export function publicKeyId(publicKey) {
  return createHash("sha256").update(publicKeyDer(publicKey)).digest("hex").slice(0, 24);
}

export function signUpdateChannel(manifest, privateKey, requestedKeyId) {
  const key = privateKey?.type === "private" ? privateKey : createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("release signing key must be Ed25519");
  const publicKey = createPublicKey(key);
  const keyId = requestedKeyId || publicKeyId(publicKey);
  if (!/^[a-z0-9][a-z0-9._-]{7,63}$/i.test(keyId)) throw new Error("signing key ID is invalid");
  const signature = cryptoSign(null, signingBytes(manifest), key).toString("base64");
  return {
    ...unsignedManifest(manifest),
    signature: { algorithm: "ed25519", keyId, value: signature },
  };
}

export function verifyUpdateChannel(manifest, publicKey) {
  if (manifest?.signature?.algorithm !== "ed25519") return false;
  if (typeof manifest.signature.value !== "string") return false;
  const key = publicKey?.type === "public" ? publicKey : createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") return false;
  let signature;
  try {
    signature = Buffer.from(manifest.signature.value, "base64");
  } catch {
    return false;
  }
  if (signature.length !== 64) return false;
  return cryptoVerify(null, signingBytes(manifest), key, signature);
}

function versionParts(value) {
  if (!/^\d+\.\d+\.\d+$/.test(value ?? "")) throw new Error(`invalid version: ${value}`);
  return value.split(".").map(Number);
}

function versionAtLeast(value, threshold) {
  const left = versionParts(value);
  const right = versionParts(threshold);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

export function verifyUpdateChannelPolicy(manifest, policy) {
  if (policy?.schemaVersion !== 1 || !Array.isArray(policy.trustedKeys)) {
    throw new Error("update signing policy is invalid");
  }
  const required = versionAtLeast(manifest.version, policy.requiredFromVersion);
  if (!manifest.signature) {
    if (required) throw new Error(`update ${manifest.version} requires an Ed25519 signature`);
    return { verified: false, legacy: true, keyId: null };
  }
  const key = policy.trustedKeys.find((candidate) => candidate.keyId === manifest.signature.keyId);
  if (!key || typeof key.publicKeySpkiBase64 !== "string") {
    throw new Error(`update signature key is not trusted: ${manifest.signature.keyId}`);
  }
  const der = Buffer.from(key.publicKeySpkiBase64, "base64");
  const publicKey = createPublicKey({ key: der, type: "spki", format: "der" });
  if (!verifyUpdateChannel(manifest, publicKey)) throw new Error("update channel signature is invalid");
  return { verified: true, legacy: false, keyId: key.keyId };
}

function parseArguments(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index];
    if (!name.startsWith("--") || index + 1 >= values.length) throw new Error(`invalid option: ${name}`);
    options[name.slice(2)] = values[index + 1];
    index += 1;
  }
  return options;
}

async function writeJsonAtomic(target, value) {
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

async function runSelfTest() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest = {
    schemaVersion: 1,
    version: "9.9.9",
    publishedAt: "2026-01-01T00:00:00Z",
    sha256: "a".repeat(64),
    size: 2_000_000,
    sources: [{ provider: "github", url: "https://github.com/example/release.exe" }],
  };
  const signed = signUpdateChannel(manifest, privateKey);
  if (!verifyUpdateChannel(signed, publicKey)) throw new Error("Ed25519 self-test verification failed");
  if (verifyUpdateChannel({ ...signed, size: signed.size + 1 }, publicKey)) {
    throw new Error("Ed25519 self-test accepted a tampered payload");
  }
  const policy = {
    schemaVersion: 1,
    requiredFromVersion: "1.0.0",
    trustedKeys: [{
      keyId: signed.signature.keyId,
      publicKeySpkiBase64: publicKeyDer(publicKey).toString("base64"),
    }],
  };
  const result = verifyUpdateChannelPolicy(signed, policy);
  if (!result.verified) throw new Error("Ed25519 policy self-test failed");
  console.log(`Ed25519 self-test passed with ephemeral key ${signed.signature.keyId}`);
}

async function main() {
  const command = process.argv[2];
  const options = parseArguments(process.argv.slice(3));
  if (command === "self-test") {
    await runSelfTest();
    return;
  }
  const manifestPath = path.resolve(options.manifest || defaultManifest);
  if (command === "sign") {
    if (!options["private-key"]) throw new Error("--private-key is required");
    const [manifest, privateKey] = await Promise.all([
      readFile(manifestPath, "utf8").then(JSON.parse),
      readFile(path.resolve(options["private-key"])),
    ]);
    const signed = signUpdateChannel(manifest, privateKey, options["key-id"]);
    await writeJsonAtomic(manifestPath, signed);
    const publicKey = createPublicKey(createPrivateKey(privateKey));
    console.log(`signed update channel with Ed25519 key ${signed.signature.keyId}`);
    console.log(`trusted publicKeySpkiBase64: ${publicKeyDer(publicKey).toString("base64")}`);
    return;
  }
  if (command === "verify-policy") {
    const policyPath = path.resolve(options.policy || defaultPolicy);
    const [manifest, policy] = await Promise.all([
      readFile(manifestPath, "utf8").then(JSON.parse),
      readFile(policyPath, "utf8").then(JSON.parse),
    ]);
    const result = verifyUpdateChannelPolicy(manifest, policy);
    console.log(result.verified
      ? `update channel signature verified: ${result.keyId}`
      : `legacy unsigned update accepted below ${policy.requiredFromVersion}`);
    return;
  }
  throw new Error(
    "usage: node tools/update-channel-signature.mjs "
      + "<self-test|sign|verify-policy> [--manifest path] [--policy path] [--private-key path]",
  );
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
