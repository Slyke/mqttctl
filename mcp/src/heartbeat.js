import { randomUUID } from "node:crypto";
import { MqttctlClient } from "./mqttctlClient.js";

export const createHeartbeat = ({ config, privateKey, buildInfo, logger }) => {
  const instanceId = randomUUID();
  const startedAt = new Date().toISOString();
  const api = new MqttctlClient({
    config,
    privateKey,
    identity: { name: "_service", access: "read" },
    logger
  });
  let timer = null;
  let stopped = false;
  let lastSuccessAt = null;
  let lastError = null;

  const send = async () => {
    try {
      await api.request({
        method: "POST",
        path: "/api/mcp/heartbeat",
        body: {
          version: buildInfo.version,
          buildHash: buildInfo.buildHash,
          instanceId,
          startedAt,
          heartbeatAt: new Date().toISOString()
        }
      });
      lastSuccessAt = new Date().toISOString();
      lastError = null;
    } catch (err) {
      lastError = err;
      logger.generateLog({
        level: "warn",
        caller: "heartbeat::send",
        loggerKey: "MCP_HEARTBEAT_FAILED",
        message: "mqttctl rejected or did not receive the MCP heartbeat.",
        context: {
          status: err?.status ?? null,
          errorKey: err?.response?.errorKey ?? null,
          reason: err?.message ?? "Unknown heartbeat error"
        }
      });
    }
  };

  const schedule = () => {
    timer = setTimeout(() => {
      if (stopped) return;
      void send().finally(schedule);
    }, config.mqttctl.heartbeatSeconds * 1000);
    timer.unref?.();
  };

  return {
    instanceId,
    startedAt,
    start: () => {
      void send().finally(schedule);
    },
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      api.close();
    },
    status: () => ({
      lastSuccessAt,
      lastError: lastError ? { status: lastError.status ?? null, reason: lastError.message } : null
    })
  };
};
