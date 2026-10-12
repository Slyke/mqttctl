import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/tools.js";

test("MCP schemas preserve defaults, strict validation, and destructive confirmation", async (t) => {
  const requests = [];
  const context = {
    config: { readOnly: false, mqttBuffer: { maxPoll: 100 } },
    identity: { name: "test", access: "readwrite" },
    logger: { generateLog() {}, generateError() {} },
    rateLimiter: { check: () => ({ allowed: true }) },
    api: { request: async (request) => {
      requests.push(request);
      return { body: { ok: true } };
    } },
    mqtt: {}
  };
  const server = createMcpServer({ context, buildInfo: { version: "test" } });
  const client = new Client({ name: "test", version: "test" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  const destructive = tools.find((tool) => tool.name === "mqttctl_delete_user");
  assert.ok(destructive.inputSchema.required.includes("confirm"));
  assert.equal(destructive.inputSchema.additionalProperties, false);

  const audit = await client.callTool({ name: "mqttctl_list_audit", arguments: {} });
  assert.equal(audit.isError, false);
  assert.equal(requests.at(-1).path, "/api/audit?limit=20");

  const invalid = await client.callTool({ name: "mqttctl_list_audit", arguments: { unexpected: true } });
  assert.equal(invalid.isError, true);
  const unconfirmed = await client.callTool({ name: "mqttctl_delete_user", arguments: { id: "user-1" } });
  assert.equal(unconfirmed.isError, true);
  assert.equal(requests.length, 1);

  const confirmed = await client.callTool({ name: "mqttctl_delete_user", arguments: { id: "user-1", confirm: true } });
  assert.equal(confirmed.isError, false);
  assert.equal(requests.at(-1).method, "DELETE");
  assert.equal(requests.at(-1).path, "/api/users/user-1");
});
