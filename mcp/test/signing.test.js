import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { createRequestProof } from "../src/mqttctlClient.js";

test("request proof is Ed25519 signed and bound to method, target, body, and delegated identity", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const bodyBytes = Buffer.from('{"enabled":true}', "utf8");
  const proof = createRequestProof({
    method: "PATCH",
    requestTarget: "/api/example?mode=one",
    bodyBytes,
    identity: { name: "writer-one", access: "readwrite" },
    config: { mqttctl: { keyId: "compose", audience: "mqttctl-api" } },
    privateKey,
    nowSeconds: 1000,
    jti: "unit-test-jti"
  });
  const [protectedPart, payloadPart, signaturePart] = proof.split(".");
  const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  const header = JSON.parse(Buffer.from(protectedPart, "base64url").toString("utf8"));

  assert.equal(header.alg, "EdDSA");
  assert.equal(header.kid, "compose");
  assert.equal(claims.sub, "writer-one");
  assert.equal(claims.access, "readwrite");
  assert.equal(claims.htm, "PATCH");
  assert.equal(claims.htu, "/api/example?mode=one");
  assert.equal(claims.body_sha256, createHash("sha256").update(bodyBytes).digest("base64url"));
  assert.equal(verify(null, Buffer.from(`${protectedPart}.${payloadPart}`), publicKey, Buffer.from(signaturePart, "base64url")), true);
});
