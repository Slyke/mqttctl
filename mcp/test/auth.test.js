import assert from "node:assert/strict";
import test from "node:test";
import { authenticateBearer } from "../src/auth.js";
import { loadConfig } from "../src/config.js";

test("named bearer tokens preserve access category without exposing token values", () => {
  const config = {
    auth: {
      tokens: [
        { name: "reader", token: "read-secret", access: "read" },
        { name: "writer", token: "write-secret", access: "readwrite" }
      ]
    }
  };
  assert.deepEqual(authenticateBearer({ authorization: "Bearer read-secret", config }), { name: "reader", access: "read" });
  assert.deepEqual(authenticateBearer({ authorization: "Bearer write-secret", config }), { name: "writer", access: "readwrite" });
  assert.equal(authenticateBearer({ authorization: "Bearer wrong", config }), null);
});

test("configuration rejects missing and duplicate bearer identities", () => {
  assert.throws(() => loadConfig({
    cwd: "/tmp",
    env: {
      HTTP_ENABLED: "true",
      HTTPS_ENABLED: "false",
      MQTTCTL_BASE_URL: "http://mqttctl:3000",
      MQTTCTL_MCP_PRIVATE_KEY_FILE: "/tmp/signing.pem"
    }
  }), /MCP_READ_BEARER_TOKENS or MCP_READWRITE_BEARER_TOKENS/);

  assert.throws(() => loadConfig({
    cwd: "/tmp",
    env: {
      HTTP_ENABLED: "true",
      HTTPS_ENABLED: "false",
      MQTTCTL_BASE_URL: "http://mqttctl:3000",
      MQTTCTL_MCP_PRIVATE_KEY_FILE: "/tmp/signing.pem",
      MCP_READ_BEARER_TOKENS: "[{name:'same',token:'one'}]",
      MCP_READWRITE_BEARER_TOKENS: "[{name:'same',token:'two'}]"
    }
  }), /must be unique/);
});
