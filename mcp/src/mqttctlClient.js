import fs from "node:fs";
import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { Agent, fetch } from "undici";

const sha256 = ({ bytes }) => createHash("sha256").update(bytes).digest("base64url");
const encodePart = ({ value }) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

export class MqttctlApiError extends Error {
  constructor({ status, response, path }) {
    super(response?.reason ?? response?.message ?? `mqttctl request failed with HTTP ${status}.`);
    this.name = "MqttctlApiError";
    this.status = status;
    this.response = response;
    this.path = path;
  }
}

export const loadSigningKey = ({ filePath }) => {
  const key = createPrivateKey(fs.readFileSync(filePath, "utf8"));
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error(`MCP signing private key at ${filePath} is ${key.asymmetricKeyType ?? "unknown"}; expected Ed25519 PKCS8 PEM.`);
  }
  return key;
};

export const createRequestProof = ({ method, requestTarget, bodyBytes, identity, config, privateKey, nowSeconds = Math.floor(Date.now() / 1000), jti = randomUUID() }) => {
  const protectedPart = encodePart({
    value: {
      alg: "EdDSA",
      typ: "mqttctl-mcp+jwt",
      kid: config.mqttctl.keyId
    }
  });
  const payloadPart = encodePart({
    value: {
      iss: "mqttctl-mcp",
      aud: config.mqttctl.audience,
      sub: identity.name,
      access: identity.access,
      iat: nowSeconds,
      exp: nowSeconds + 20,
      jti,
      htm: method.toUpperCase(),
      htu: requestTarget,
      body_sha256: sha256({ bytes: bodyBytes })
    }
  });
  const signingInput = `${protectedPart}.${payloadPart}`;
  const signaturePart = sign(null, Buffer.from(signingInput, "utf8"), privateKey).toString("base64url");
  return `${signingInput}.${signaturePart}`;
};

const parseResponseBody = async ({ response }) => {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json().catch(() => null);
  }
  return await response.text();
};

const attachmentName = ({ value }) => {
  const match = String(value ?? "").match(/filename="?([^";]+)"?/i);
  return match?.[1] ?? null;
};

export class MqttctlClient {
  constructor({ config, privateKey, identity, logger }) {
    this.config = config;
    this.privateKey = privateKey;
    this.identity = identity;
    this.logger = logger;
    this.cookies = new Map();
    this.dispatcher = config.mqttctl.verifyTls ? undefined : new Agent({ connect: { rejectUnauthorized: false } });
  }

  updateCookies({ response }) {
    const values = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    for (const value of values) {
      const pair = String(value).split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async fetchSigned({ method = "GET", path, body, signal, streaming = false }) {
    const bodyBytes = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8");
    const url = new URL(path, `${this.config.mqttctl.baseUrl}/`);
    const requestTarget = `${url.pathname}${url.search}`;
    const proof = createRequestProof({
      method,
      requestTarget,
      bodyBytes,
      identity: this.identity,
      config: this.config,
      privateKey: this.privateKey
    });
    const headers = {
      accept: streaming ? "text/event-stream" : "application/json",
      authorization: `MQTTCTL-MCP ${proof}`
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : bodyBytes,
      signal: signal ?? (streaming ? undefined : AbortSignal.timeout(this.config.mqttctl.timeoutMs)),
      dispatcher: this.dispatcher
    });
    this.updateCookies({ response });
    return response;
  }

  async request({ method = "GET", path, body }) {
    const response = await this.fetchSigned({ method, path, body });
    const responseBody = await parseResponseBody({ response });
    if (!response.ok) throw new MqttctlApiError({ status: response.status, response: responseBody, path });

    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      fileName: attachmentName({ value: response.headers.get("content-disposition") }),
      body: responseBody
    };
  }

  async openEventStream({ signal }) {
    const response = await this.fetchSigned({ method: "GET", path: "/api/mqtt/events", signal, streaming: true });
    if (!response.ok) {
      const responseBody = await parseResponseBody({ response });
      throw new MqttctlApiError({ status: response.status, response: responseBody, path: "/api/mqtt/events" });
    }
    return response;
  }

  close() {
    void this.dispatcher?.close();
  }
}
