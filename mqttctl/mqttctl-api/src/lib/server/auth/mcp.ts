import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { stat, readFile } from 'node:fs/promises';
import type { AuthenticatedUser, McpAccessState, McpDelegatedIdentity, McpRuntimeInfo } from '$lib/types';
import type { LoadedRuntimeConfig } from '$server/config/load';
import type { AppDatabase, StoredUser } from '$server/db';
import type { AppLogger } from '$server/logging/logger';
import { capabilities, defaultMcpCapabilities, type Capability } from '$server/permissions';

export const mcpSystemUserId = 'system:mcp';
export const mcpSystemUsername = 'mcp';
export const mcpServiceSubject = '_service';

const mcpSettingsScope = 'auth.mcp';
const mcpAllowedCapabilitiesKey = 'allowedCapabilities';
const clientNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const safeReadMethods = new Set(['GET', 'HEAD']);
const transientReadPaths = new Set([
  'POST /api/mcp/heartbeat',
  'POST /api/mqtt/connect',
  'POST /api/mqtt/disconnect',
  'POST /api/mqtt/messages',
  'POST /api/mqtt/subscribe',
  'POST /api/mqtt/unsubscribe'
]);

interface McpProofClaims {
  iss: string;
  aud: string;
  sub: string;
  access: 'read' | 'readwrite';
  iat: number;
  exp: number;
  jti: string;
  htm: string;
  htu: string;
  body_sha256: string;
}

interface HeartbeatInput {
  version: string;
  buildHash: string;
  instanceId: string;
  startedAt: string;
  heartbeatAt: string;
}

interface HeartbeatRecord extends HeartbeatInput {
  receivedAt: string;
}

const isCapability = (value: string): value is Capability => (
  capabilities.includes(value as Capability)
);

const parseJsonPart = ({ value }: { value: string }) => {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};

const bodyDigest = ({ bytes }: { bytes: Uint8Array }) => createHash('sha256').update(bytes).digest('base64url');

const publicKeyFingerprint = ({ key }: { key: KeyObject }) => createHash('sha256').update(key.export({
  type: 'spki',
  format: 'der'
})).digest('base64url');

const normalizeCapabilities = ({ value }: { value: unknown }): Capability[] => {
  if (!Array.isArray(value)) return [...defaultMcpCapabilities];

  return [...new Set(value
    .filter((entry): entry is string => typeof entry === 'string')
    .filter((entry) => isCapability(entry))
    .filter((entry) => entry !== 'manage_mcp'))];
};

export class McpAuthService {
  private publicKey: KeyObject | null = null;
  private fingerprint: string | null = null;
  private heartbeat: HeartbeatRecord | null = null;
  private readonly replayCache = new Map<string, number>();

  constructor(
    private readonly db: AppDatabase,
    private readonly runtimeConfig: LoadedRuntimeConfig,
    private readonly logger: AppLogger
  ) {}

  isConfigured() {
    return this.runtimeConfig.config.auth.mcp.enabled;
  }

  private fatalKeyError({ err, stage }: { err: unknown; stage: string }) {
    const publicKeyFile = this.runtimeConfig.config.auth.mcp.publicKeyFile;
    return this.logger.generateError({
      caller: 'mcpAuth::initialize',
      reason: `MCP authentication is enabled, but mqttctl could not load the required Ed25519 public key at ${publicKeyFile}. mqttctl is intentionally exiting. The key must be an Ed25519 public key in PEM SPKI format. In Docker Compose, verify that mqttctl-mcp-keygen completed and the mqttctl-mcp-public volume is mounted. To disable this check, set auth.mcp.enabled to false or MQTTCTL_MCP_AUTH_ENABLED=false.`,
      errorKey: 'MCP_AUTH_PUBLIC_KEY_LOAD_FAILED',
      err,
      includeStackTrace: false,
      context: {
        mcpAuthEnabled: true,
        publicKeyFile,
        requiredFormat: 'PEM SPKI Ed25519 public key',
        stage,
        keyGeneratorService: 'mqttctl-mcp-keygen',
        publicKeyVolume: 'mqttctl-mcp-public',
        disableConfig: 'auth.mcp.enabled=false',
        disableEnvironment: 'MQTTCTL_MCP_AUTH_ENABLED=false'
      }
    });
  }

  private async loadPublicKey() {
    const publicKeyFile = this.runtimeConfig.config.auth.mcp.publicKeyFile;

    try {
      const fileStat = await stat(publicKeyFile);
      if (!fileStat.isFile()) {
        throw new Error('Configured MCP public-key path is not a regular file.');
      }
    } catch (err) {
      throw this.fatalKeyError({ err, stage: 'stat' });
    }

    let pem: string;
    try {
      pem = await readFile(publicKeyFile, 'utf8');
    } catch (err) {
      throw this.fatalKeyError({ err, stage: 'read' });
    }

    try {
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== 'ed25519') {
        throw new Error(`Configured MCP public key has type ${key.asymmetricKeyType ?? 'unknown'}, expected ed25519.`);
      }

      this.publicKey = key;
      this.fingerprint = publicKeyFingerprint({ key });
    } catch (err) {
      throw this.fatalKeyError({ err, stage: 'parse' });
    }
  }

  private async ensureSystemUser() {
    const byId = await this.db.getUserById({ userId: mcpSystemUserId });
    const byUsername = await this.db.getUserByUsername({ username: mcpSystemUsername });
    const existing = byId ?? byUsername;

    if (
      existing
      && (
        existing.id !== mcpSystemUserId
        || existing.username !== mcpSystemUsername
        || existing.authSource !== 'mcp'
        || existing.role !== 'mcp'
        || (byId && byUsername && byId.id !== byUsername.id)
      )
    ) {
      throw this.logger.generateError({
        caller: 'mcpAuth::ensureSystemUser',
        reason: 'The reserved mqttctl MCP system-user identity conflicts with an existing user.',
        errorKey: 'MCP_AUTH_SYSTEM_USER_CONFLICT',
        context: {
          expectedId: mcpSystemUserId,
          expectedUsername: mcpSystemUsername,
          existingId: existing.id,
          existingAuthSource: existing.authSource,
          existingRole: existing.role
        }
      });
    }

    if (!existing) {
      const now = new Date().toISOString();
      await this.db.createUser({
        id: mcpSystemUserId,
        username: mcpSystemUsername,
        email: null,
        role: 'mcp',
        authSource: 'mcp',
        externalSubject: null,
        passwordHash: null,
        protectedFromAutoLink: true,
        disabled: false,
        sessionVersion: 0,
        createdAt: now,
        updatedAt: now
      });
      return;
    }

    if (
      existing.email !== null
      || existing.passwordHash !== null
      || existing.externalSubject !== null
      || !existing.protectedFromAutoLink
    ) {
      await this.db.updateUser({
        userId: existing.id,
        email: null,
        role: 'mcp',
        authSource: 'mcp',
        externalSubject: null,
        passwordHash: null,
        disabled: existing.disabled,
        sessionVersion: existing.sessionVersion + 1,
        updatedAt: new Date().toISOString()
      });
      await this.db.deleteSessionsForUser({ userId: existing.id });
      await this.db.setUserProtectedFromAutoLink({
        userId: existing.id,
        protectedFromAutoLink: true,
        updatedAt: new Date().toISOString()
      });
    }
  }

  async initialize() {
    if (!this.isConfigured()) return;
    await this.loadPublicKey();
    await this.ensureSystemUser();

    this.logger.generateLog({
      level: 'info',
      caller: 'mcpAuth::initialize',
      loggerKey: 'MCP_AUTH_INITIALIZED',
      message: 'MCP machine authentication initialized.',
      context: {
        keyId: this.runtimeConfig.config.auth.mcp.keyId,
        publicKeyFile: this.runtimeConfig.config.auth.mcp.publicKeyFile,
        publicKeyFingerprint: this.fingerprint,
        audience: this.runtimeConfig.config.auth.mcp.audience
      }
    });
  }

  private async getSystemUser() {
    return await this.db.getUserById({ userId: mcpSystemUserId });
  }

  async getAllowedCapabilities() {
    const stored = await this.db.getSetting<unknown>({
      scope: mcpSettingsScope,
      key: mcpAllowedCapabilitiesKey
    });
    return normalizeCapabilities({ value: stored });
  }

  private toAuthenticatedUser({
    user,
    capabilities: allowedCapabilities,
    delegatedIdentity
  }: {
    user: StoredUser;
    capabilities: Capability[];
    delegatedIdentity: McpDelegatedIdentity;
  }): AuthenticatedUser {
    return {
      id: user.id,
      username: user.username,
      email: null,
      role: 'mcp',
      authSource: 'mcp',
      capabilities: allowedCapabilities,
      delegatedIdentity
    };
  }

  private proofError({
    reason,
    errorKey = 'MCP_AUTH_PROOF_INVALID',
    correlationId,
    status = 401,
    context = null,
    err
  }: {
    reason: string;
    errorKey?: string;
    correlationId: string | null;
    status?: number;
    context?: unknown;
    err?: unknown;
  }) {
    return this.logger.generateError({
      caller: 'mcpAuth::authenticateRequest',
      reason,
      errorKey,
      correlationId,
      status,
      context,
      err,
      includeStackTrace: false
    });
  }

  private purgeReplayCache({ nowSeconds }: { nowSeconds: number }) {
    for (const [jti, expiresAt] of this.replayCache.entries()) {
      if (expiresAt < nowSeconds) this.replayCache.delete(jti);
    }
  }

  private rememberJti({ jti, expiresAt, nowSeconds, correlationId }: {
    jti: string;
    expiresAt: number;
    nowSeconds: number;
    correlationId: string | null;
  }) {
    this.purgeReplayCache({ nowSeconds });
    if (this.replayCache.has(jti)) {
      throw this.proofError({
        reason: 'MCP request proof was replayed.',
        errorKey: 'MCP_AUTH_PROOF_REPLAYED',
        correlationId,
        status: 401
      });
    }

    if (this.replayCache.size >= this.runtimeConfig.config.auth.mcp.replayCacheMaxEntries) {
      throw this.proofError({
        reason: 'MCP request replay cache is full.',
        errorKey: 'MCP_AUTH_REPLAY_CACHE_FULL',
        correlationId,
        status: 503,
        context: {
          maxEntries: this.runtimeConfig.config.auth.mcp.replayCacheMaxEntries
        }
      });
    }

    this.replayCache.set(jti, expiresAt);
  }

  private validateClaims({
    claims,
    request,
    requestBodyDigest,
    correlationId
  }: {
    claims: Record<string, unknown>;
    request: Request;
    requestBodyDigest: string;
    correlationId: string | null;
  }): McpProofClaims {
    const requiredStringClaims = ['iss', 'aud', 'sub', 'access', 'jti', 'htm', 'htu', 'body_sha256'] as const;
    const requiredNumberClaims = ['iat', 'exp'] as const;

    if (
      requiredStringClaims.some((key) => typeof claims[key] !== 'string')
      || requiredNumberClaims.some((key) => typeof claims[key] !== 'number' || !Number.isInteger(claims[key]))
    ) {
      throw this.proofError({
        reason: 'MCP request proof is missing required claims.',
        correlationId
      });
    }

    const validated = claims as unknown as McpProofClaims;
    const config = this.runtimeConfig.config.auth.mcp;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const requestUrl = new URL(request.url);
    const requestTarget = `${requestUrl.pathname}${requestUrl.search}`;

    if (validated.iss !== 'mqttctl-mcp' || validated.aud !== config.audience) {
      throw this.proofError({
        reason: 'MCP request proof issuer or audience is invalid.',
        correlationId
      });
    }

    if (validated.access !== 'read' && validated.access !== 'readwrite') {
      throw this.proofError({
        reason: 'MCP request proof access value is invalid.',
        correlationId
      });
    }

    if (validated.sub !== mcpServiceSubject && !clientNamePattern.test(validated.sub)) {
      throw this.proofError({
        reason: 'MCP request proof subject is invalid.',
        correlationId
      });
    }

    if (
      validated.iat > nowSeconds + config.clockSkewSeconds
      || validated.exp < nowSeconds - config.clockSkewSeconds
      || validated.exp <= validated.iat
      || validated.exp - validated.iat > config.maxProofAgeSeconds
    ) {
      throw this.proofError({
        reason: 'MCP request proof timestamp window is invalid or expired.',
        correlationId
      });
    }

    if (
      validated.htm !== request.method.toUpperCase()
      || validated.htu !== requestTarget
      || validated.body_sha256 !== requestBodyDigest
    ) {
      throw this.proofError({
        reason: 'MCP request proof is not bound to this HTTP request.',
        correlationId
      });
    }

    const requestKey = `${request.method.toUpperCase()} ${requestUrl.pathname}`;
    if (
      validated.access === 'read'
      && !safeReadMethods.has(request.method.toUpperCase())
      && !transientReadPaths.has(requestKey)
    ) {
      throw this.proofError({
        reason: 'Read-only MCP identity cannot call this HTTP operation.',
        errorKey: 'MCP_AUTH_READ_ONLY_METHOD_DENIED',
        correlationId,
        status: 403,
        context: {
          method: request.method,
          path: requestUrl.pathname
        }
      });
    }

    if (
      validated.sub === mcpServiceSubject
      && requestKey !== 'POST /api/mcp/heartbeat'
    ) {
      throw this.proofError({
        reason: 'MCP service identity is restricted to the heartbeat endpoint.',
        errorKey: 'MCP_AUTH_SERVICE_SUBJECT_DENIED',
        correlationId,
        status: 403
      });
    }

    this.rememberJti({
      jti: validated.jti,
      expiresAt: validated.exp + config.clockSkewSeconds,
      nowSeconds,
      correlationId
    });
    return validated;
  }

  async authenticateRequest({
    request,
    correlationId
  }: {
    request: Request;
    correlationId: string | null;
  }): Promise<AuthenticatedUser | null> {
    if (!this.isConfigured()) return null;

    const authorization = request.headers.get('authorization');
    if (!authorization) return null;

    const match = authorization.match(/^MQTTCTL-MCP\s+([^\s]+)$/i);
    if (!match) return null;
    if (!this.publicKey) {
      throw this.proofError({
        reason: 'MCP public key is not initialized.',
        correlationId,
        status: 503
      });
    }

    const compactJws = match[1] ?? '';
    const parts = compactJws.split('.');
    if (parts.length !== 3) {
      throw this.proofError({
        reason: 'MCP request proof format is invalid.',
        correlationId
      });
    }

    const [protectedPart, payloadPart, signaturePart] = parts;
    const protectedHeader = parseJsonPart({ value: protectedPart ?? '' });
    const claims = parseJsonPart({ value: payloadPart ?? '' });
    if (!protectedHeader || !claims) {
      throw this.proofError({
        reason: 'MCP request proof JSON is invalid.',
        correlationId
      });
    }

    if (
      protectedHeader.alg !== 'EdDSA'
      || protectedHeader.typ !== 'mqttctl-mcp+jwt'
      || protectedHeader.kid !== this.runtimeConfig.config.auth.mcp.keyId
    ) {
      throw this.proofError({
        reason: 'MCP request proof protected header is invalid.',
        correlationId
      });
    }

    let signature: Buffer;
    try {
      signature = Buffer.from(signaturePart ?? '', 'base64url');
    } catch (err) {
      throw this.proofError({
        reason: 'MCP request proof signature encoding is invalid.',
        correlationId,
        err
      });
    }

    const signatureValid = verifySignature(
      null,
      Buffer.from(`${protectedPart}.${payloadPart}`, 'utf8'),
      this.publicKey,
      signature
    );
    if (!signatureValid) {
      throw this.proofError({
        reason: 'MCP request proof signature is invalid.',
        correlationId
      });
    }

    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await request.clone().arrayBuffer());
    } catch (err) {
      throw this.proofError({
        reason: 'MCP request body could not be read for proof validation.',
        correlationId,
        err
      });
    }

    const validated = this.validateClaims({
      claims,
      request,
      requestBodyDigest: bodyDigest({ bytes: bodyBytes }),
      correlationId
    });
    const user = await this.getSystemUser();
    if (!user || user.authSource !== 'mcp' || user.role !== 'mcp') {
      throw this.proofError({
        reason: 'MCP system user is unavailable.',
        errorKey: 'MCP_AUTH_SYSTEM_USER_UNAVAILABLE',
        correlationId,
        status: 503
      });
    }

    if (user.disabled) {
      throw this.proofError({
        reason: 'The mqttctl MCP user is disabled.',
        errorKey: 'MCP_AUTH_USER_DISABLED',
        correlationId,
        status: 403
      });
    }

    return this.toAuthenticatedUser({
      user,
      capabilities: await this.getAllowedCapabilities(),
      delegatedIdentity: {
        clientName: validated.sub,
        access: validated.access
      }
    });
  }

  async setAccess({
    disabled,
    allowedCapabilities
  }: {
    disabled: boolean;
    allowedCapabilities: string[];
  }) {
    if (!this.isConfigured()) {
      throw this.logger.generateError({
        caller: 'mcpAuth::setAccess',
        reason: 'MCP authentication is disabled in mqttctl configuration.',
        errorKey: 'MCP_AUTH_SYSTEM_USER_UNAVAILABLE',
        status: 503,
        context: {
          enableConfig: 'auth.mcp.enabled=true',
          enableEnvironment: 'MQTTCTL_MCP_AUTH_ENABLED=true'
        }
      });
    }

    const user = await this.getSystemUser();
    if (!user) {
      throw this.logger.generateError({
        caller: 'mcpAuth::setAccess',
        reason: 'MCP system user is unavailable.',
        errorKey: 'MCP_AUTH_SYSTEM_USER_UNAVAILABLE',
        status: 503
      });
    }

    const normalizedCapabilities = normalizeCapabilities({ value: allowedCapabilities });
    await Promise.all([
      this.db.updateUser({
        userId: user.id,
        email: null,
        role: 'mcp',
        authSource: 'mcp',
        externalSubject: null,
        passwordHash: null,
        disabled,
        sessionVersion: user.sessionVersion + (disabled !== user.disabled ? 1 : 0),
        updatedAt: new Date().toISOString()
      }),
      this.db.setSetting({
        scope: mcpSettingsScope,
        key: mcpAllowedCapabilitiesKey,
        value: normalizedCapabilities,
        updatedAt: new Date().toISOString()
      })
    ]);

    if (disabled !== user.disabled) {
      await this.db.deleteSessionsForUser({ userId: user.id });
    }

    if (disabled) {
      this.heartbeat = null;
    }
  }

  recordHeartbeat({ input }: { input: HeartbeatInput }) {
    this.heartbeat = {
      ...input,
      receivedAt: new Date().toISOString()
    };
  }

  async getRuntimeInfo(): Promise<McpRuntimeInfo> {
    if (!this.isConfigured()) {
      return {
        enabled: false,
        connected: false,
        reason: 'disabled',
        version: null,
        buildHash: null,
        instanceId: null,
        startedAt: null,
        lastSeenAt: null,
        heartbeatExpiresAt: null
      };
    }

    const user = await this.getSystemUser();
    const heartbeatExpiresAt = this.heartbeat
      ? new Date(new Date(this.heartbeat.receivedAt).getTime() + (this.runtimeConfig.config.auth.mcp.heartbeatStaleSeconds * 1000)).toISOString()
      : null;
    const heartbeatFresh = Boolean(heartbeatExpiresAt && heartbeatExpiresAt > new Date().toISOString());
    const connected = Boolean(user && !user.disabled && heartbeatFresh);
    const reason = !user
      ? 'user_unavailable'
      : user.disabled
        ? 'user_disabled'
        : !this.heartbeat
          ? 'never_connected'
          : heartbeatFresh
            ? 'connected'
            : 'heartbeat_stale';

    return {
      enabled: true,
      connected,
      reason,
      version: this.heartbeat?.version ?? null,
      buildHash: this.heartbeat?.buildHash ?? null,
      instanceId: this.heartbeat?.instanceId ?? null,
      startedAt: this.heartbeat?.startedAt ?? null,
      lastSeenAt: this.heartbeat?.receivedAt ?? null,
      heartbeatExpiresAt
    };
  }

  async getAccessState(): Promise<McpAccessState> {
    const user = await this.getSystemUser();
    return {
      id: mcpSystemUserId,
      username: mcpSystemUsername,
      role: 'mcp',
      authSource: 'mcp',
      disabled: user?.disabled ?? true,
      defaultCapabilities: [...defaultMcpCapabilities],
      allowedCapabilities: await this.getAllowedCapabilities(),
      signingKey: this.getPublicKeyMetadata(),
      runtime: await this.getRuntimeInfo()
    };
  }

  async assertPrincipalEnabled({ correlationId }: { correlationId: string | null }) {
    const user = await this.getSystemUser();
    if (!this.isConfigured() || !user || user.disabled) {
      throw this.proofError({
        reason: user?.disabled ? 'The mqttctl MCP user is disabled.' : 'MCP authentication is unavailable.',
        errorKey: user?.disabled ? 'MCP_AUTH_USER_DISABLED' : 'MCP_AUTH_SYSTEM_USER_UNAVAILABLE',
        correlationId,
        status: user?.disabled ? 403 : 503
      });
    }

    if (!(await this.getAllowedCapabilities()).includes('read')) {
      throw this.proofError({
        reason: 'The mqttctl MCP user no longer has read capability.',
        errorKey: 'PERMISSION_DENIED',
        correlationId,
        status: 403
      });
    }
  }

  getPublicKeyMetadata() {
    return {
      keyId: this.runtimeConfig.config.auth.mcp.keyId,
      fingerprint: this.fingerprint
    };
  }
}
