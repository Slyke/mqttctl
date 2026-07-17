import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const ensureHttpsCertificates = ({ certsDir }) => {
  const certPath = path.join(certsDir, "server.crt");
  const keyPath = path.join(certsDir, "server.key");
  fs.mkdirSync(certsDir, { recursive: true });

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    const result = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650",
      "-subj", "/CN=mqttctl-mcp", "-addext", "subjectAltName=DNS:localhost,DNS:mqttctl-mcp,IP:127.0.0.1",
      "-keyout", keyPath, "-out", certPath
    ], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Failed generating HTTPS certificate: ${result.stderr || result.stdout}`);
    fs.chmodSync(keyPath, 0o600);
    fs.chmodSync(certPath, 0o644);
  }

  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
};
