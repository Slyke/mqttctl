import fs from "node:fs";
import path from "node:path";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

const privateKeyFile = process.env.MQTTCTL_MCP_PRIVATE_KEY_FILE ?? "/run/mqttctl-mcp-private/signing-private.pem";
const publicKeyFile = process.env.MQTTCTL_MCP_PUBLIC_KEY_FILE ?? "/run/mqttctl-mcp-public/signing-public.pem";

fs.mkdirSync(path.dirname(privateKeyFile), { recursive: true });
fs.mkdirSync(path.dirname(publicKeyFile), { recursive: true });

let privateKey;
if (fs.existsSync(privateKeyFile)) {
  privateKey = createPrivateKey(fs.readFileSync(privateKeyFile, "utf8"));
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(`Existing MCP private key at ${privateKeyFile} is not Ed25519. Refusing to overwrite it.`);
  }
} else {
  privateKey = generateKeyPairSync("ed25519").privateKey;
  const temporaryPrivateFile = `${privateKeyFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPrivateFile, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  fs.renameSync(temporaryPrivateFile, privateKeyFile);
}

fs.chmodSync(privateKeyFile, 0o600);
const publicKey = createPublicKey(privateKey);
const publicPem = publicKey.export({ type: "spki", format: "pem" });
const temporaryPublicFile = `${publicKeyFile}.${process.pid}.tmp`;
fs.writeFileSync(temporaryPublicFile, publicPem, { mode: 0o644 });
fs.renameSync(temporaryPublicFile, publicKeyFile);
fs.chmodSync(publicKeyFile, 0o644);

const ownerUid = Number.parseInt(process.env.MCP_KEY_OWNER_UID ?? "1000", 10);
const ownerGid = Number.parseInt(process.env.MCP_KEY_OWNER_GID ?? "1000", 10);
if (process.getuid?.() === 0 && Number.isInteger(ownerUid) && Number.isInteger(ownerGid)) {
  fs.chownSync(privateKeyFile, ownerUid, ownerGid);
  fs.chownSync(publicKeyFile, ownerUid, ownerGid);
}

const fingerprint = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("base64url");
console.log(JSON.stringify({
  timestamp: new Date().toISOString(),
  level: "info",
  caller: "generate-signing-keypair",
  loggerKey: "MCP_SIGNING_KEYPAIR_READY",
  message: "mqttctl MCP Ed25519 signing keypair is ready.",
  context: { privateKeyFile, publicKeyFile, fingerprint }
}));
