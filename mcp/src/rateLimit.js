export const createRateLimiter = ({ config, now = () => Date.now() }) => {
  const windows = new Map();

  return {
    check: ({ identityName, category }) => {
      const limit = config.rateLimits[category];
      const key = `${identityName}:${category}`;
      const currentTime = now();
      const existing = windows.get(key);
      const windowState = !existing || currentTime >= existing.resetAt
        ? { count: 0, resetAt: currentTime + config.rateLimits.windowMs }
        : existing;
      windowState.count += 1;
      windows.set(key, windowState);

      return {
        allowed: windowState.count <= limit,
        limit,
        remaining: Math.max(0, limit - windowState.count),
        retryAfterSeconds: Math.max(1, Math.ceil((windowState.resetAt - currentTime) / 1000))
      };
    }
  };
};
