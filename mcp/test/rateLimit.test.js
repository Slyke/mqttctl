import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimiter } from "../src/rateLimit.js";

test("rate limits are isolated by named identity and category and reset after the window", () => {
  let now = 1000;
  const limiter = createRateLimiter({
    config: { rateLimits: { windowMs: 1000, read: 2, write: 1, destructive: 1 } },
    now: () => now
  });
  assert.equal(limiter.check({ identityName: "one", category: "read" }).allowed, true);
  assert.equal(limiter.check({ identityName: "one", category: "read" }).allowed, true);
  assert.equal(limiter.check({ identityName: "one", category: "read" }).allowed, false);
  assert.equal(limiter.check({ identityName: "two", category: "read" }).allowed, true);
  assert.equal(limiter.check({ identityName: "one", category: "write" }).allowed, true);
  now = 2000;
  assert.equal(limiter.check({ identityName: "one", category: "read" }).allowed, true);
});
