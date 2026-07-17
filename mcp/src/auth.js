import { createHash, timingSafeEqual } from "node:crypto";

const digest = ({ value }) => createHash("sha256").update(String(value)).digest();

export const authenticateBearer = ({ authorization, config }) => {
  const match = String(authorization ?? "").match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const supplied = digest({ value: match[1] });

  for (const entry of config.auth.tokens) {
    if (timingSafeEqual(supplied, digest({ value: entry.token }))) {
      return { name: entry.name, access: entry.access };
    }
  }
  return null;
};

export const toMcpAuthInfo = ({ identity }) => ({
  token: "<redacted>",
  clientId: identity.name,
  scopes: identity.access === "readwrite" ? ["read", "write"] : ["read"]
});
