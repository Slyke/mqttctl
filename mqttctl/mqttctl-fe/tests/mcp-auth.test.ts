import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpAuthService, mcpSystemUserId } from '$server/auth/mcp';
import { createAppError } from '$server/logging/errors';
import type { AppLogger } from '$server/logging/logger';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => await rm(directory, { recursive: true, force: true })));
});

const createLogger = () => ({
  generateLog: vi.fn(),
  generateError: vi.fn((options) => createAppError({
    caller: options.caller ?? 'test',
    reason: options.reason ?? 'test error',
    errorKey: options.errorKey ?? 'ERR_UNKNOWN',
    correlationId: options.correlationId ?? null,
    status: options.status ?? 500,
    context: options.context,
    cause: options.err
  }))
} as unknown as AppLogger);

const createRuntimeConfig = ({ publicKeyFile }: { publicKeyFile: string }) => ({
  config: {
    auth: {
      mcp: {
        enabled: true,
        publicKeyFile,
        keyId: 'test-key',
        audience: 'mqttctl-api',
        maxProofAgeSeconds: 30,
        clockSkewSeconds: 5,
        replayCacheMaxEntries: 100,
        heartbeatStaleSeconds: 45
      }
    }
  }
}) as never;

const createProof = ({
  privateKey,
  method,
  target,
  body = '',
  subject = 'test-agent',
  access = 'read',
  jti = randomUUID()
}: {
  privateKey: KeyObject;
  method: string;
  target: string;
  body?: string;
  subject?: string;
  access?: 'read' | 'readwrite';
  jti?: string;
}) => {
  const now = Math.floor(Date.now() / 1000);
  const protectedPart = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'mqttctl-mcp+jwt', kid: 'test-key' })).toString('base64url');
  const payloadPart = Buffer.from(JSON.stringify({
    iss: 'mqttctl-mcp',
    aud: 'mqttctl-api',
    sub: subject,
    access,
    iat: now,
    exp: now + 20,
    jti,
    htm: method,
    htu: target,
    body_sha256: createHash('sha256').update(body).digest('base64url')
  })).toString('base64url');
  const signingInput = `${protectedPart}.${payloadPart}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString('base64url')}`;
};

describe('McpAuthService', () => {
  it('creates the protected passwordless identity, authenticates a bound proof, and rejects replay', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mqttctl-mcp-auth-'));
    temporaryDirectories.push(directory);
    const publicKeyFile = path.join(directory, 'signing-public.pem');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    await writeFile(publicKeyFile, publicKey.export({ type: 'spki', format: 'pem' }));
    let storedUser: Record<string, unknown> | null = null;
    const db = {
      getUserById: vi.fn(async () => storedUser),
      getUserByUsername: vi.fn(async () => storedUser),
      createUser: vi.fn(async (user) => { storedUser = user; }),
      updateUser: vi.fn(),
      deleteSessionsForUser: vi.fn(),
      setUserProtectedFromAutoLink: vi.fn(),
      getSetting: vi.fn(async () => null)
    };
    const service = new McpAuthService(db as never, createRuntimeConfig({ publicKeyFile }), createLogger());
    await service.initialize();

    expect(db.createUser).toHaveBeenCalledWith(expect.objectContaining({
      id: mcpSystemUserId,
      username: 'mcp',
      role: 'mcp',
      authSource: 'mcp',
      passwordHash: null,
      protectedFromAutoLink: true
    }));

    const target = '/api/me?detail=1';
    const proof = createProof({ privateKey, method: 'GET', target });
    const request = new Request(`http://localhost${target}`, {
      headers: { authorization: `MQTTCTL-MCP ${proof}` }
    });
    await expect(service.authenticateRequest({ request, correlationId: 'corr-mcp-1' })).resolves.toEqual(expect.objectContaining({
      id: mcpSystemUserId,
      role: 'mcp',
      authSource: 'mcp',
      delegatedIdentity: { clientName: 'test-agent', access: 'read' }
    }));
    await expect(service.authenticateRequest({ request, correlationId: 'corr-mcp-2' })).rejects.toMatchObject({
      errorKey: 'MCP_AUTH_PROOF_REPLAYED',
      status: 401
    });

    const writeBody = JSON.stringify({ username: 'blocked' });
    const readOnlyWriteProof = createProof({
      privateKey,
      method: 'POST',
      target: '/api/users',
      body: writeBody,
      access: 'read'
    });
    await expect(service.authenticateRequest({
      request: new Request('http://localhost/api/users', {
        method: 'POST',
        body: writeBody,
        headers: {
          authorization: `MQTTCTL-MCP ${readOnlyWriteProof}`,
          'content-type': 'application/json'
        }
      }),
      correlationId: 'corr-mcp-read-only'
    })).rejects.toMatchObject({ errorKey: 'MCP_AUTH_READ_ONLY_METHOD_DENIED', status: 403 });

    const validTamperTarget = createProof({ privateKey, method: 'GET', target: '/api/me' });
    const tamperedParts = validTamperTarget.split('.');
    const originalSignature = tamperedParts[2]!;
    tamperedParts[2] = `${originalSignature.startsWith('A') ? 'B' : 'A'}${originalSignature.slice(1)}`;
    const tamperedProof = tamperedParts.join('.');
    await expect(service.authenticateRequest({
      request: new Request('http://localhost/api/me', {
        headers: { authorization: `MQTTCTL-MCP ${tamperedProof}` }
      }),
      correlationId: 'corr-mcp-tampered'
    })).rejects.toMatchObject({ errorKey: 'MCP_AUTH_PROOF_INVALID', status: 401 });

    (storedUser as unknown as Record<string, unknown>).disabled = true;
    const disabledProof = createProof({ privateKey, method: 'GET', target: '/api/me' });
    await expect(service.authenticateRequest({
      request: new Request('http://localhost/api/me', {
        headers: { authorization: `MQTTCTL-MCP ${disabledProof}` }
      }),
      correlationId: 'corr-mcp-disabled'
    })).rejects.toMatchObject({ errorKey: 'MCP_AUTH_USER_DISABLED', status: 403 });
  });

  it('fails startup with an actionable generated error when the configured public key is absent', async () => {
    const publicKeyFile = path.join(tmpdir(), `missing-mqttctl-mcp-${randomUUID()}.pem`);
    const service = new McpAuthService({} as never, createRuntimeConfig({ publicKeyFile }), createLogger());

    await expect(service.initialize()).rejects.toMatchObject({
      errorKey: 'MCP_AUTH_PUBLIC_KEY_LOAD_FAILED',
      message: expect.stringContaining(publicKeyFile),
      context: expect.objectContaining({
        disableConfig: 'auth.mcp.enabled=false',
        disableEnvironment: 'MQTTCTL_MCP_AUTH_ENABLED=false'
      })
    });
  });
});
