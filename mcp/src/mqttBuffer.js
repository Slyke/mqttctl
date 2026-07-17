const wait = async ({ ms, signal }) => await new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(signal.reason ?? new Error("Aborted"));
  }, { once: true });
});

export class SseParser {
  constructor({ onEvent }) {
    this.onEvent = onEvent;
    this.pending = "";
  }

  push({ chunk }) {
    this.pending += chunk;
    let separator = this.pending.match(/\r?\n\r?\n/);
    while (separator?.index !== undefined) {
      const frame = this.pending.slice(0, separator.index).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      this.pending = this.pending.slice(separator.index + separator[0].length);
      this.parseFrame({ frame });
      separator = this.pending.match(/\r?\n\r?\n/);
    }
  }

  parseFrame({ frame }) {
    let event = "message";
    const data = [];
    for (const line of frame.split("\n")) {
      if (!line || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
      if (field === "event") event = value;
      if (field === "data") data.push(value);
    }
    if (data.length) this.onEvent({ event, data: data.join("\n") });
  }
}

export class MqttMessageBuffer {
  constructor({ api, config, logger, identity, now = () => Date.now() }) {
    this.api = api;
    this.config = config;
    this.logger = logger;
    this.identity = identity;
    this.now = now;
    this.queue = [];
    this.queuedBytes = 0;
    this.droppedMessages = 0;
    this.droppedBytes = 0;
    this.lastPolledAt = null;
    this.expiresAt = null;
    this.lastEventAt = null;
    this.sseConnected = false;
    this.sseAbort = null;
    this.desiredSse = false;
    this.closed = false;
    this.cleanupInFlight = null;
    this.upstreamState = null;
    this.terminalError = null;
    this.maintenanceTimer = setInterval(() => {
      void this.expireIfIdle().catch((err) => {
        this.logger.generateError({
          caller: "mqttBuffer::maintenance",
          reason: "MQTT inactivity cleanup failed.",
          errorKey: "MCP_MQTT_CLEANUP_FAILED",
          err,
          context: { identityName: this.identity.name }
        });
      });
    }, 60_000);
    this.maintenanceTimer.unref?.();
  }

  startActivityDeadline() {
    if (this.lastPolledAt) return;
    this.lastPolledAt = new Date(this.now()).toISOString();
    this.expiresAt = new Date(this.now() + this.config.mqttBuffer.inactivityMs).toISOString();
  }

  refreshPollDeadline() {
    this.lastPolledAt = new Date(this.now()).toISOString();
    this.expiresAt = new Date(this.now() + this.config.mqttBuffer.inactivityMs).toISOString();
  }

  append({ message }) {
    if (this.closed) return;
    const byteLength = Number.isFinite(message?.byteLength)
      ? Math.max(0, message.byteLength)
      : Buffer.byteLength(String(message?.payload ?? ""), "utf8");
    const entry = { ...message, bufferedAt: new Date(this.now()).toISOString() };
    this.queue.push({ entry, byteLength });
    this.queuedBytes += byteLength;
    this.lastEventAt = entry.bufferedAt;

    while (
      this.queue.length > this.config.mqttBuffer.maxMessages
      || this.queuedBytes > this.config.mqttBuffer.maxBytes
    ) {
      const dropped = this.queue.shift();
      if (!dropped) break;
      this.queuedBytes -= dropped.byteLength;
      this.droppedMessages += 1;
      this.droppedBytes += dropped.byteLength;
    }

    if (this.droppedMessages) {
      this.logger.generateLog({
        level: "warn",
        caller: "mqttBuffer::append",
        loggerKey: "MCP_MQTT_BUFFER_OVERFLOW",
        message: "MCP MQTT buffer dropped oldest messages at its configured bound.",
        context: {
          identityName: this.identity.name,
          queuedMessages: this.queue.length,
          queuedBytes: this.queuedBytes,
          droppedMessages: this.droppedMessages,
          droppedBytes: this.droppedBytes
        }
      });
    }
  }

  handleSseEvent({ event, data }) {
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    this.lastEventAt = new Date(this.now()).toISOString();
    if (event === "mqtt-message" && parsed?.message) this.append({ message: parsed.message });
    if (event === "message" && parsed?.explorer) this.upstreamState = parsed.explorer;
  }

  ensureSse() {
    if (this.closed || this.desiredSse) return;
    this.desiredSse = true;
    void this.consumeSse().catch((err) => {
      if (this.closed || !this.desiredSse) return;
      this.logger.generateError({
        caller: "mqttBuffer::consumeSse",
        reason: "MQTT event stream stopped unexpectedly.",
        errorKey: "MCP_MQTT_SSE_FAILED",
        err,
        context: { identityName: this.identity.name }
      });
    });
  }

  async consumeSse() {
    let attempt = 0;
    while (this.desiredSse && !this.closed) {
      this.sseAbort = new AbortController();
      try {
        const response = await this.api.openEventStream({ signal: this.sseAbort.signal });
        this.sseConnected = true;
        this.terminalError = null;
        attempt = 0;
        const parser = new SseParser({ onEvent: (event) => this.handleSseEvent(event) });
        for await (const chunk of response.body) {
          if (!this.desiredSse || this.closed) break;
          parser.push({ chunk: Buffer.from(chunk).toString("utf8") });
        }
      } catch (err) {
        if (!this.desiredSse || this.closed || this.sseAbort?.signal.aborted) break;
        if (err?.status === 401 || err?.status === 403) {
          this.terminalError = {
            status: err.status,
            errorKey: err.response?.errorKey ?? null,
            reason: err.message
          };
          await this.cleanup({ callUpstream: false, closeBuffer: false });
          return;
        }
      } finally {
        this.sseConnected = false;
        this.sseAbort = null;
      }

      if (!this.desiredSse || this.closed) break;
      attempt += 1;
      const delayMs = Math.min(30_000, 500 * (2 ** Math.min(attempt, 6))) + Math.floor(Math.random() * 250);
      try {
        await wait({ ms: delayMs });
      } catch {
        return;
      }
    }
  }

  stopSse() {
    this.desiredSse = false;
    this.sseAbort?.abort();
    this.sseAbort = null;
    this.sseConnected = false;
  }

  async connect({ input }) {
    const result = await this.api.request({ method: "POST", path: "/api/mqtt/connect", body: input });
    this.upstreamState = result.body?.data?.explorer ?? null;
    this.startActivityDeadline();
    return result.body;
  }

  async subscribe({ filter, qos }) {
    const result = await this.api.request({ method: "POST", path: "/api/mqtt/subscribe", body: { filter, qos } });
    this.upstreamState = result.body?.data?.explorer ?? null;
    this.startActivityDeadline();
    this.ensureSse();
    return result.body;
  }

  async unsubscribe({ filter }) {
    const result = await this.api.request({ method: "POST", path: "/api/mqtt/unsubscribe", body: { filter } });
    this.upstreamState = result.body?.data?.explorer ?? null;
    if (!(this.upstreamState?.subscriptions?.length > 0)) this.stopSse();
    return result.body;
  }

  async getState() {
    const result = await this.api.request({ method: "GET", path: "/api/mqtt/state" });
    this.upstreamState = result.body?.data?.explorer ?? null;
    return result.body;
  }

  async poll({ maxMessages }) {
    await this.api.request({ method: "GET", path: "/api/me" });
    const count = Math.min(this.config.mqttBuffer.maxPoll, Math.max(1, maxMessages ?? this.config.mqttBuffer.defaultPoll));
    const selected = this.queue.splice(0, count);
    const returnedBytes = selected.reduce((sum, item) => sum + item.byteLength, 0);
    this.queuedBytes -= returnedBytes;
    this.refreshPollDeadline();
    return {
      ok: true,
      messages: selected.map((item) => item.entry),
      returned: selected.length,
      remaining: this.queue.length,
      queuedBytes: this.queuedBytes,
      droppedMessages: this.droppedMessages,
      droppedBytes: this.droppedBytes,
      overflowed: this.droppedMessages > 0,
      lastPolledAt: this.lastPolledAt,
      expiresAt: this.expiresAt,
      upstream: {
        sseConnected: this.sseConnected,
        lastEventAt: this.lastEventAt,
        terminalError: this.terminalError
      }
    };
  }

  async status({ includeUpstream = false } = {}) {
    await this.api.request({ method: "GET", path: "/api/me" });
    if (includeUpstream) await this.getState();
    return {
      ok: true,
      queuedMessages: this.queue.length,
      queuedBytes: this.queuedBytes,
      droppedMessages: this.droppedMessages,
      droppedBytes: this.droppedBytes,
      overflowed: this.droppedMessages > 0,
      lastPolledAt: this.lastPolledAt,
      expiresAt: this.expiresAt,
      sseConnected: this.sseConnected,
      lastEventAt: this.lastEventAt,
      terminalError: this.terminalError,
      upstreamState: includeUpstream ? this.upstreamState : undefined
    };
  }

  async clear() {
    const result = await this.api.request({ method: "POST", path: "/api/mqtt/messages", body: { action: "clear" } });
    this.queue = [];
    this.queuedBytes = 0;
    this.droppedMessages = 0;
    this.droppedBytes = 0;
    return result.body;
  }

  async setTrackedTopicsLimit({ limit }) {
    const result = await this.api.request({ method: "POST", path: "/api/mqtt/messages", body: { action: "set_limit", limit } });
    return result.body;
  }

  async publish({ input }) {
    const result = await this.api.request({ method: "POST", path: "/api/mqtt/publish", body: input });
    return result.body;
  }

  async disconnect() {
    let upstream = null;
    try {
      upstream = (await this.api.request({ method: "POST", path: "/api/mqtt/disconnect", body: {} })).body;
    } finally {
      await this.cleanup({ callUpstream: false, closeBuffer: false });
    }
    return { ok: true, upstream, cleanedUp: true };
  }

  async expireIfIdle() {
    if (!this.expiresAt || this.now() <= new Date(this.expiresAt).getTime()) return false;
    await this.cleanup({ callUpstream: true, closeBuffer: false });
    this.logger.generateLog({
      level: "info",
      caller: "mqttBuffer::expireIfIdle",
      loggerKey: "MCP_MQTT_SESSION_EXPIRED",
      message: "Expired MCP MQTT session after no message-buffer poll.",
      context: { identityName: this.identity.name, inactivityMs: this.config.mqttBuffer.inactivityMs }
    });
    return true;
  }

  async cleanup({ callUpstream, closeBuffer }) {
    if (this.cleanupInFlight) return await this.cleanupInFlight;
    this.cleanupInFlight = (async () => {
      this.stopSse();
      if (callUpstream) {
        try {
          await this.api.request({ method: "POST", path: "/api/mqtt/disconnect", body: {} });
        } catch (err) {
          this.logger.generateError({
            caller: "mqttBuffer::cleanup",
            reason: "Best-effort mqttctl MQTT disconnect failed.",
            errorKey: "MCP_MQTT_DISCONNECT_FAILED",
            err,
            context: { identityName: this.identity.name }
          });
        }
      }
      this.queue = [];
      this.queuedBytes = 0;
      this.droppedMessages = 0;
      this.droppedBytes = 0;
      this.upstreamState = null;
      this.lastPolledAt = null;
      this.expiresAt = null;
      if (closeBuffer) {
        this.closed = true;
        clearInterval(this.maintenanceTimer);
      }
    })();
    try {
      await this.cleanupInFlight;
    } finally {
      this.cleanupInFlight = null;
    }
  }

  async close() {
    await this.cleanup({ callUpstream: true, closeBuffer: true });
  }
}
