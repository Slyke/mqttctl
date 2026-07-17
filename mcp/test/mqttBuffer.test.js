import assert from "node:assert/strict";
import test from "node:test";
import { MqttMessageBuffer, SseParser } from "../src/mqttBuffer.js";

const logger = {
  generateLog: () => {},
  generateError: () => new Error("logged")
};

const createConfig = () => ({
  mqttBuffer: {
    inactivityMs: 60_000,
    maxMessages: 2,
    maxBytes: 100,
    defaultPoll: 100,
    maxPoll: 1000
  }
});

test("SSE parser handles chunk boundaries, comments, named events, and multiline data", () => {
  const events = [];
  const parser = new SseParser({ onEvent: (event) => events.push(event) });
  parser.push({ chunk: ": ping\n\nevent: mqtt-" });
  parser.push({ chunk: "message\r\ndata: {\"message\":\r\ndata: {\"topic\":\"one\"}}\r" });
  parser.push({ chunk: "\n\r\n" });
  assert.deepEqual(events, [{ event: "mqtt-message", data: '{"message":\n{"topic":"one"}}' }]);
});

test("buffer drops oldest messages visibly and poll atomically drains in receive order", async () => {
  const requests = [];
  const api = {
    request: async (request) => {
      requests.push(request);
      return { body: { ok: true } };
    }
  };
  let now = 1000;
  const buffer = new MqttMessageBuffer({ api, config: createConfig(), logger, identity: { name: "reader" }, now: () => now });
  buffer.append({ message: { topic: "one", payload: "1", byteLength: 1 } });
  buffer.append({ message: { topic: "two", payload: "2", byteLength: 1 } });
  buffer.append({ message: { topic: "three", payload: "3", byteLength: 1 } });

  now = 2000;
  const result = await buffer.poll({ maxMessages: 1 });
  assert.deepEqual(result.messages.map((message) => message.topic), ["two"]);
  assert.equal(result.remaining, 1);
  assert.equal(result.droppedMessages, 1);
  assert.equal(result.overflowed, true);
  assert.equal(result.expiresAt, new Date(62_000).toISOString());
  assert.equal(requests[0].path, "/api/me");
  await buffer.close();
});

test("one-hour-style inactivity expiry closes SSE, requests upstream disconnect, and discards data", async () => {
  const requests = [];
  const api = {
    request: async (request) => {
      requests.push(request);
      return { body: { data: { explorer: { subscriptions: [] } } } };
    }
  };
  let now = 10_000;
  const config = createConfig();
  const buffer = new MqttMessageBuffer({ api, config, logger, identity: { name: "reader" }, now: () => now });
  await buffer.connect({ input: { host: "broker", port: 1883, tls: false, authMode: "custom", username: "u", password: "p", clientId: "c" } });
  buffer.append({ message: { topic: "one", payload: "data", byteLength: 4 } });
  now += config.mqttBuffer.inactivityMs + 1;

  assert.equal(await buffer.expireIfIdle(), true);
  assert.equal(requests.some((request) => request.path === "/api/mqtt/disconnect"), true);
  assert.equal((await buffer.status()).queuedMessages, 0);
  await buffer.close();
});
