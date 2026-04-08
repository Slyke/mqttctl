import { createHmac, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import argon2 from 'argon2';
import type { AuthMethod, UserRole } from '$lib/types';
import type { AuditService } from '$server/audit/service';
import type { LoadedRuntimeConfig } from '$server/config/load';
import { AppDatabase, type StoredUser } from '$server/db';
import { generateLog, type AppLogger, type LogLevel } from '$server/logging/logger';
import { AppError, createAppError } from '$server/logging/errors';
import { createOidcAuthorizationUrl, exchangeOidcCallback } from '$server/auth/oidc';
import type { AuthenticatedUser, CreateUserInput, LocalLoginInput } from '$server/auth/types';
import { createBootstrapPassword, normalizeUsername } from '$server/utils/passwords';
import { createOpaqueToken, createCorrelationId } from '$server/utils/ids';

const sessionCookieName = 'mqttctl_session';
type AuthEventLoggingConfig = NonNullable<LoadedRuntimeConfig['config']['logging']['failedLoginAttempts']>;

export class AuthService {
  private readonly trustedProxyList: BlockList;

  constructor(
    private readonly db: AppDatabase,
    private readonly runtimeConfig: LoadedRuntimeConfig,
    private readonly logger: AppLogger,
    private readonly audit: AuditService
  ) {
    this.trustedProxyList = new BlockList();

    for (const cidr of this.runtimeConfig.config.auth.header?.trustedCidrs ?? []) {
      const [rawAddress, prefix] = cidr.split('/');
      const address = rawAddress ?? '';
      const version = isIP(address);
      if (!version || !prefix) continue;
      this.trustedProxyList.addSubnet(address, Number.parseInt(prefix, 10), version === 6 ? 'ipv6' : 'ipv4');
    }
  }

  getSessionCookieName() {
    return sessionCookieName;
  }

  getCookieOptions() {
    const basePath = this.runtimeConfig.config.basePath || '/';
    return {
      path: basePath === '' ? '/' : basePath,
      httpOnly: true,
      sameSite: 'lax' as const,
      secure: this.runtimeConfig.config.publicBaseUrl.startsWith('https://')
    };
  }

  getDefaultPostLoginRedirectPath() {
    return `${this.runtimeConfig.config.basePath}/dashboard`;
  }

  private getOidcRedirectUri() {
    const configuredCallbackUrl = this.runtimeConfig.config.auth.oidc?.callbackUrl;
    if (configuredCallbackUrl) return configuredCallbackUrl;

    return `${this.runtimeConfig.config.publicBaseUrl}${this.runtimeConfig.config.basePath}/auth/callback`;
  }

  getSafePostLoginRedirectPath({ redirectTo }: { redirectTo: string | null | undefined }) {
    const fallback = this.getDefaultPostLoginRedirectPath();
    const candidate = redirectTo?.trim();
    if (!candidate) return fallback;

    try {
      const publicBaseUrl = new URL(this.runtimeConfig.config.publicBaseUrl);
      const resolved = new URL(candidate, publicBaseUrl);
      if (resolved.origin !== publicBaseUrl.origin) {
        return fallback;
      }

      const basePath = this.runtimeConfig.config.basePath === '/' ? '' : this.runtimeConfig.config.basePath;
      if (
        basePath
        && resolved.pathname !== basePath
        && !resolved.pathname.startsWith(`${basePath}/`)
      ) {
        return fallback;
      }

      return `${resolved.pathname}${resolved.search}${resolved.hash}`;
    } catch {
      return fallback;
    }
  }

  private async ensureBootstrapAdminProtection({
    bootstrapUsername
  }: {
    bootstrapUsername: string;
  }) {
    const bootstrapUser = await this.db.getUserByUsername({ username: bootstrapUsername });
    const fallbackCandidates = bootstrapUser
      ? [bootstrapUser]
      : (await this.db.listUsers()).filter((user) =>
          user.authSource === 'local'
          && user.role === 'super_admin'
        );
    const protectedUser = fallbackCandidates.length === 1 ? fallbackCandidates[0] : null;

    if (
      !protectedUser
      || protectedUser.protectedFromAutoLink
      || protectedUser.authSource !== 'local'
      || protectedUser.role !== 'super_admin'
    ) {
      return;
    }

    await this.db.setUserProtectedFromAutoLink({
      userId: protectedUser.id,
      protectedFromAutoLink: true,
      updatedAt: new Date().toISOString()
    });
  }

  async bootstrapInitialAdmin({ correlationId }: { correlationId: string | null }) {
    const bootstrapUsername = normalizeUsername({ username: this.runtimeConfig.secrets.bootstrapAdmin?.username ?? 'admin' });
    const userCount = await this.db.countUsers();
    if (userCount > 0) {
      await this.ensureBootstrapAdminProtection({ bootstrapUsername });
      return;
    }

    const bootstrapEmail = this.runtimeConfig.secrets.bootstrapAdmin?.email ?? null;
    const generatedPassword = this.runtimeConfig.secrets.bootstrapAdmin?.password ?? createBootstrapPassword();
    const passwordHash = await argon2.hash(generatedPassword, { type: argon2.argon2id });
    const now = new Date().toISOString();

    try {
      await this.db.createUser({
        id: createOpaqueToken({ bytes: 18 }),
        username: bootstrapUsername,
        email: bootstrapEmail,
        role: 'super_admin',
        authSource: 'local',
        externalSubject: null,
        passwordHash,
        protectedFromAutoLink: true,
        disabled: false,
        sessionVersion: 0,
        createdAt: now,
        updatedAt: now
      });
    } catch (error) {
      throw createAppError({
        caller: 'auth::bootstrapInitialAdmin',
        reason: 'Failed creating bootstrap administrator.',
        errorKey: 'USER_BOOTSTRAP_FAILED',
        correlationId,
        cause: error
      });
    }

    if (!this.runtimeConfig.secrets.bootstrapAdmin?.password) {
      console.error('##### MQTTCTL BOOTSTRAP ADMIN #####');
      console.error(`username: ${bootstrapUsername}`);
      console.error(`password: ${generatedPassword}`);
      console.error('##### MQTTCTL BOOTSTRAP ADMIN #####');
    }
  }

  sanitizeUser({ user }: { user: StoredUser }): AuthenticatedUser {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      authSource: user.authSource
    };
  }

  private async syncExternalAccount({
    user,
    authSource,
    externalSubject,
    email
  }: {
    user: StoredUser;
    authSource: 'oidc' | 'header';
    externalSubject: string | null;
    email: string | null;
  }) {
    const nextSessionVersion = (
      user.authSource !== authSource
      || user.externalSubject !== externalSubject
      || user.passwordHash !== null
      || user.disabled
    )
      ? user.sessionVersion + 1
      : user.sessionVersion;
    const updatedAt = new Date().toISOString();

    await this.db.updateUser({
      userId: user.id,
      email,
      role: user.role,
      authSource,
      externalSubject,
      passwordHash: null,
      disabled: false,
      sessionVersion: nextSessionVersion,
      updatedAt
    });

    if (nextSessionVersion !== user.sessionVersion) {
      await this.db.deleteSessionsForUser({ userId: user.id });
    }

    return {
      ...user,
      email,
      authSource,
      externalSubject,
      passwordHash: null,
      disabled: false,
      sessionVersion: nextSessionVersion,
      updatedAt
    };
  }

  private ensureAccountCanAutoLink({
    user,
    authMethod,
    correlationId
  }: {
    user: StoredUser;
    authMethod: 'oidc' | 'header';
    correlationId: string | null;
  }) {
    if (!user.protectedFromAutoLink) return;

    throw createAppError({
      caller: 'auth::ensureAccountCanAutoLink',
      reason: `${authMethod.toUpperCase()} login cannot auto-link to a protected local account.`,
      errorKey: authMethod === 'header' ? 'AUTH_HEADER_INVALID' : 'AUTH_OIDC_CALLBACK_FAILED',
      correlationId,
      status: 403
    });
  }

  private emitAuthLog({
    level,
    caller,
    message,
    correlationId,
    context,
    errorKey,
    sinks
  }: {
    level: LogLevel;
    caller: string;
    message: string;
    correlationId: string | null;
    context: Record<string, unknown>;
    errorKey?: string | null;
    sinks: AuthEventLoggingConfig;
  }) {
    generateLog({
      logger: this.logger,
      level,
      caller,
      message,
      correlationId: this.runtimeConfig.config.logging.includeCorrelationId ? correlationId : null,
      context,
      errorKey: errorKey ?? null,
      sinks: {
        console: sinks.console,
        file: sinks.file,
        curl: sinks.curl
      }
    });
  }

  private buildAuthLogContext({
    authMethod,
    sourceIp,
    userAgent,
    submittedUsername,
    normalizedUsername,
    user,
    failureReason,
    sessionExpiresAt
  }: {
    authMethod: AuthMethod;
    sourceIp: string | null;
    userAgent: string | null;
    submittedUsername?: string | null;
    normalizedUsername?: string | null;
    user?: StoredUser | null;
    failureReason?: string | null;
    sessionExpiresAt?: string | null;
  }) {
    const context: Record<string, unknown> = {
      authMethod,
      sourceIp,
      username: user?.username ?? normalizedUsername ?? submittedUsername ?? null
    };

    if (submittedUsername && submittedUsername !== context.username) {
      context.submittedUsername = submittedUsername;
    }

    if (this.runtimeConfig.config.logging.includeNormalizedUsername) {
      context.normalizedUsername = normalizedUsername ?? user?.username ?? null;
    }

    if (this.runtimeConfig.config.logging.includeUserAgent) {
      context.userAgent = userAgent;
    }

    if (user) {
      context.userId = user.id;
      context.role = user.role;
    }

    if (failureReason) {
      context.failureReason = failureReason;
    }

    if (
      sessionExpiresAt
      && this.runtimeConfig.config.logging.includeSessionExpiry
    ) {
      context.sessionExpiresAt = sessionExpiresAt;
    }

    return context;
  }

  private logFailedLocalLogin({
    username,
    normalizedUsername,
    user,
    sourceIp,
    userAgent,
    correlationId,
    errorKey,
    failureReason
  }: {
    username: string;
    normalizedUsername: string;
    user: StoredUser | null;
    sourceIp: string | null;
    userAgent: string | null;
    correlationId: string | null;
    errorKey: string;
    failureReason: string;
  }) {
    const logConfig = this.runtimeConfig.config.logging.failedLoginAttempts;
    if (!logConfig) return;

    this.emitAuthLog({
      level: logConfig.level,
      caller: 'auth::loginLocal',
      message: 'Local login failed.',
      correlationId,
      errorKey,
      sinks: logConfig,
      context: this.buildAuthLogContext({
        authMethod: 'local',
        sourceIp,
        userAgent,
        submittedUsername: username,
        normalizedUsername,
        user,
        failureReason
      })
    });
  }

  private logSuccessfulLogin({
    authMethod,
    user,
    sourceIp,
    userAgent,
    sessionExpiresAt,
    correlationId
  }: {
    authMethod: AuthMethod;
    user: StoredUser;
    sourceIp: string | null;
    userAgent: string | null;
    sessionExpiresAt: string;
    correlationId: string | null;
  }) {
    const logConfig = this.runtimeConfig.config.logging.successfulLogin;
    if (!logConfig) return;

    this.emitAuthLog({
      level: logConfig.level,
      caller: 'auth::createSessionForUser',
      message: `${authMethod} login succeeded.`,
      correlationId,
      sinks: logConfig,
      context: this.buildAuthLogContext({
        authMethod,
        sourceIp,
        userAgent,
        normalizedUsername: user.username,
        user,
        sessionExpiresAt
      })
    });
  }

  private async recordLoginAudit({
    authMethod,
    actor,
    sourceIp,
    correlationId,
    targetId,
    beforeSummary = null,
    afterSummary = null,
    commandResult = null,
    success
  }: {
    authMethod: AuthMethod;
    actor: StoredUser | null;
    sourceIp: string | null;
    correlationId: string | null;
    targetId: string | null;
    beforeSummary?: unknown;
    afterSummary?: unknown;
    commandResult?: unknown;
    success: boolean;
  }) {
    await this.audit.record({
      actor,
      authMode: authMethod,
      sourceIp,
      correlationId: correlationId ?? createCorrelationId(),
      action: `auth.login.${authMethod}`,
      targetType: 'auth_login',
      targetId,
      beforeSummary,
      afterSummary,
      commandResult,
      success
    });
  }

  private signSessionId({ sessionId }: { sessionId: string }) {
    return createHmac('sha256', this.runtimeConfig.secrets.sessionSecret).update(sessionId).digest('base64url');
  }

  private buildSessionCookieValue({ sessionId }: { sessionId: string }) {
    return `${sessionId}.${this.signSessionId({ sessionId })}`;
  }

  private extractSessionId({ cookieValue }: { cookieValue: string | null | undefined }) {
    if (!cookieValue) return null;
    const [sessionId, signature] = cookieValue.split('.');
    if (!sessionId || !signature) return null;

    const expected = this.signSessionId({ sessionId });
    if (signature.length !== expected.length) return null;
    const valid = timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    return valid ? sessionId : null;
  }

  async listUsers() {
    const users = await this.db.listUsers();
    return users.map(({ passwordHash: _passwordHash, ...user }) => user);
  }

  async createUser({
    username,
    email = null,
    password = null,
    role,
    authSource = 'local',
    externalSubject = null,
    correlationId
  }: CreateUserInput & { correlationId: string | null }) {
    const normalizedUsername = normalizeUsername({ username });
    const existing = await this.db.getUserByUsername({ username: normalizedUsername });
    if (existing) {
      throw createAppError({
        caller: 'auth::createUser',
        reason: 'Username already exists.',
        errorKey: 'USER_CREATE_FAILED',
        correlationId,
        status: 409
      });
    }

    if (authSource === 'local' && !password) {
      throw createAppError({
        caller: 'auth::createUser',
        reason: 'Password is required for local accounts.',
        errorKey: 'INPUT_INVALID',
        correlationId,
        status: 400
      });
    }

    if (authSource !== 'local' && password) {
      throw createAppError({
        caller: 'auth::createUser',
        reason: 'Non-local accounts cannot store local passwords.',
        errorKey: 'INPUT_INVALID',
        correlationId,
        status: 400
      });
    }

    const now = new Date().toISOString();
    await this.db.createUser({
      id: createOpaqueToken({ bytes: 18 }),
      username: normalizedUsername,
      email,
      role,
      authSource,
      externalSubject,
      passwordHash: authSource === 'local' && password ? await argon2.hash(password, { type: argon2.argon2id }) : null,
      protectedFromAutoLink: false,
      disabled: false,
      sessionVersion: 0,
      createdAt: now,
      updatedAt: now
    });
  }

  async updateUser({
    userId,
    email,
    role,
    disabled,
    password,
    correlationId
  }: {
    userId: string;
    email: string | null;
    role: UserRole;
    disabled: boolean;
    password: string | null;
    correlationId: string | null;
  }) {
    const existing = await this.db.getUserById({ userId });
    if (!existing) {
      throw createAppError({
        caller: 'auth::updateUser',
        reason: 'User not found.',
        errorKey: 'USER_UPDATE_FAILED',
        correlationId,
        status: 404
      });
    }

    if (existing.authSource !== 'local' && disabled) {
      throw createAppError({
        caller: 'auth::updateUser',
        reason: 'Only local accounts can be disabled.',
        errorKey: 'INPUT_INVALID',
        correlationId,
        status: 400
      });
    }

    if (existing.authSource !== 'local' && password) {
      throw createAppError({
        caller: 'auth::updateUser',
        reason: 'Only local accounts can reset passwords.',
        errorKey: 'INPUT_INVALID',
        correlationId,
        status: 400
      });
    }

    const nextPasswordHash = existing.authSource === 'local'
      ? password
        ? await argon2.hash(password, { type: argon2.argon2id })
        : existing.passwordHash
      : null;
    const nextDisabled = existing.authSource === 'local' ? disabled : false;
    const nextSessionVersion = (
      nextPasswordHash !== existing.passwordHash
      || nextDisabled !== existing.disabled
    )
      ? existing.sessionVersion + 1
      : existing.sessionVersion;

    await this.db.updateUser({
      userId,
      email,
      role,
      authSource: existing.authSource,
      externalSubject: existing.externalSubject,
      passwordHash: nextPasswordHash,
      disabled: nextDisabled,
      sessionVersion: nextSessionVersion,
      updatedAt: new Date().toISOString()
    });

    if (nextSessionVersion !== existing.sessionVersion) {
      await this.db.deleteSessionsForUser({ userId });
    }
  }

  async deleteUser({ userId }: { userId: string }) {
    await this.db.deleteUser({ userId });
  }

  async loginLocal({
    username,
    password,
    sourceIp,
    userAgent,
    correlationId
  }: LocalLoginInput & {
    sourceIp: string | null;
    userAgent: string | null;
    correlationId: string | null;
  }) {
    const normalizedUsername = normalizeUsername({ username });

    if (!this.runtimeConfig.config.auth.localEnabled) {
      const error = createAppError({
        caller: 'auth::loginLocal',
        reason: 'Local authentication is disabled.',
        errorKey: 'AUTH_LOGIN_FAILED',
        correlationId,
        status: 403
      });

      this.logFailedLocalLogin({
        username,
        normalizedUsername,
        user: null,
        sourceIp,
        userAgent,
        correlationId,
        errorKey: error.errorKey,
        failureReason: 'local_auth_disabled'
      });

      await this.recordLoginAudit({
        authMethod: 'local',
        actor: null,
        sourceIp,
        correlationId,
        targetId: normalizedUsername || null,
        beforeSummary: {
          submittedUsername: username || null,
          normalizedUsername,
          authMethod: 'local'
        },
        commandResult: {
          failureReason: 'local_auth_disabled',
          errorKey: error.errorKey
        },
        success: false
      });

      throw error;
    }

    const user = await this.db.getUserByUsername({ username: normalizedUsername });

    if (!user || !user.passwordHash || user.disabled) {
      const error = createAppError({
        caller: 'auth::loginLocal',
        reason: 'Invalid username or password.',
        errorKey: 'AUTH_PASSWORD_INVALID',
        correlationId,
        status: 401
      });

      this.logFailedLocalLogin({
        username,
        normalizedUsername,
        user,
        sourceIp,
        userAgent,
        correlationId,
        errorKey: error.errorKey,
        failureReason: !user
          ? 'user_not_found'
          : user.disabled
            ? 'user_disabled'
            : 'password_hash_missing'
      });

      await this.recordLoginAudit({
        authMethod: 'local',
        actor: null,
        sourceIp,
        correlationId,
        targetId: normalizedUsername || null,
        beforeSummary: {
          submittedUsername: username || null,
          normalizedUsername,
          authMethod: 'local'
        },
        commandResult: {
          failureReason: !user
            ? 'user_not_found'
            : user.disabled
              ? 'user_disabled'
              : 'password_hash_missing',
          errorKey: error.errorKey
        },
        success: false
      });

      throw error;
    }

    const valid = await argon2.verify(user.passwordHash, password);
    if (!valid) {
      const error = createAppError({
        caller: 'auth::loginLocal',
        reason: 'Invalid username or password.',
        errorKey: 'AUTH_PASSWORD_INVALID',
        correlationId,
        status: 401
      });

      this.logFailedLocalLogin({
        username,
        normalizedUsername,
        user,
        sourceIp,
        userAgent,
        correlationId,
        errorKey: error.errorKey,
        failureReason: 'password_mismatch'
      });

      await this.recordLoginAudit({
        authMethod: 'local',
        actor: null,
        sourceIp,
        correlationId,
        targetId: normalizedUsername || null,
        beforeSummary: {
          submittedUsername: username || null,
          normalizedUsername,
          authMethod: 'local'
        },
        commandResult: {
          failureReason: 'password_mismatch',
          errorKey: error.errorKey
        },
        success: false
      });

      throw error;
    }

    return await this.createSessionForUser({
      user,
      authMethod: 'local',
      sourceIp,
      userAgent,
      correlationId
    });
  }

  async createSessionForUser({
    user,
    authMethod,
    sourceIp,
    userAgent,
    correlationId
  }: {
    user: StoredUser;
    authMethod: AuthMethod;
    sourceIp: string | null;
    userAgent: string | null;
    correlationId: string | null;
  }) {
    const sessionId = createOpaqueToken({ bytes: 32 });
    const expiresAt = new Date(Date.now() + (this.runtimeConfig.config.auth.sessionTtlMinutes * 60_000)).toISOString();
    const now = new Date().toISOString();

    await this.db.createSession({
      id: sessionId,
      userId: user.id,
      authMethod,
      expiresAt,
      sessionVersion: user.sessionVersion,
      sourceIp,
      userAgent,
      createdAt: now,
      updatedAt: now
    });

    this.logSuccessfulLogin({
      authMethod,
      user,
      sourceIp,
      userAgent,
      sessionExpiresAt: expiresAt,
      correlationId
    });

    await this.recordLoginAudit({
      authMethod,
      actor: user,
      sourceIp,
      correlationId,
      targetId: user.username,
      beforeSummary: {
        authMethod
      },
      afterSummary: {
        username: user.username,
        userId: user.id,
        role: user.role,
        authSource: user.authSource
      },
      commandResult: {
        sessionExpiresAt: expiresAt
      },
      success: true
    });

    return {
      user: this.sanitizeUser({ user }),
      sessionId,
      cookieValue: this.buildSessionCookieValue({ sessionId }),
      expiresAt
    };
  }

  async getUserFromCookie({ cookieValue }: { cookieValue: string | null | undefined }) {
    const sessionId = this.extractSessionId({ cookieValue });
    if (!sessionId) return null;

    const session = await this.db.getSession({ sessionId });
    if (!session) return null;

    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      await this.db.deleteSession({ sessionId });
      return null;
    }

    const user = await this.db.getUserById({ userId: session.userId });
    if (
      !user
      || user.disabled
      || user.sessionVersion !== session.sessionVersion
    ) {
      await this.db.deleteSession({ sessionId });
      return null;
    }

    return this.sanitizeUser({ user });
  }

  async logout({ cookieValue }: { cookieValue: string | null | undefined }) {
    const sessionId = this.extractSessionId({ cookieValue });
    if (!sessionId) return;
    await this.db.deleteSession({ sessionId });
  }

  async beginOidcLogin({
    redirectTo,
    correlationId
  }: {
    redirectTo: string | null;
    correlationId: string | null;
  }) {
    const oidcConfig = this.runtimeConfig.config.auth.oidc;
    if (!this.runtimeConfig.config.auth.oidcEnabled || !oidcConfig || !this.runtimeConfig.secrets.oidcClientSecret) {
      throw createAppError({
        caller: 'auth::beginOidcLogin',
        reason: 'OIDC authentication is disabled.',
        errorKey: 'AUTH_LOGIN_FAILED',
        correlationId,
        status: 403
      });
    }

    const redirectUri = this.getOidcRedirectUri();
    const { state, codeVerifier, redirectUrl } = await createOidcAuthorizationUrl({
      issuerUrl: oidcConfig.issuerUrl,
      clientId: oidcConfig.clientId,
      clientSecret: this.runtimeConfig.secrets.oidcClientSecret,
      tokenEndpointAuthMethod: oidcConfig.tokenEndpointAuthMethod,
      authorizationEndpoint: oidcConfig.authorizationEndpoint,
      tokenEndpoint: oidcConfig.tokenEndpoint,
      userinfoEndpoint: oidcConfig.userinfoEndpoint,
      redirectUri,
      scope: oidcConfig.scopes.join(' '),
      correlationId
    });

    await this.db.upsertAuthRequest({
      state,
      codeVerifier,
      redirectTo: this.getSafePostLoginRedirectPath({ redirectTo }),
      createdAt: new Date().toISOString()
    });

    return redirectUrl;
  }

  async completeOidcLogin({
    callbackUrl,
    sourceIp,
    userAgent,
    correlationId
  }: {
    callbackUrl: URL;
    sourceIp: string | null;
    userAgent: string | null;
    correlationId: string | null;
  }) {
    const state = callbackUrl.searchParams.get('state') ?? '';
    try {
      const oidcConfig = this.runtimeConfig.config.auth.oidc;
      if (!this.runtimeConfig.config.auth.oidcEnabled || !oidcConfig || !this.runtimeConfig.secrets.oidcClientSecret) {
        throw createAppError({
          caller: 'auth::completeOidcLogin',
          reason: 'OIDC authentication is disabled.',
          errorKey: 'AUTH_OIDC_CALLBACK_FAILED',
          correlationId,
          status: 403
        });
      }

      const authRequest = await this.db.getAuthRequest({ state });

      if (!state || !authRequest) {
        throw createAppError({
          caller: 'auth::completeOidcLogin',
          reason: 'OIDC callback state is invalid or expired.',
          errorKey: 'AUTH_OIDC_CALLBACK_FAILED',
          correlationId,
          status: 400
        });
      }

      await this.db.deleteAuthRequest({ state });

      const redirectUri = this.getOidcRedirectUri();
      const { claims, userInfo } = await exchangeOidcCallback({
        issuerUrl: oidcConfig.issuerUrl,
        clientId: oidcConfig.clientId,
        clientSecret: this.runtimeConfig.secrets.oidcClientSecret,
        tokenEndpointAuthMethod: oidcConfig.tokenEndpointAuthMethod,
        authorizationEndpoint: oidcConfig.authorizationEndpoint,
        tokenEndpoint: oidcConfig.tokenEndpoint,
        userinfoEndpoint: oidcConfig.userinfoEndpoint,
        redirectUri,
        callbackUrl,
        expectedState: state,
        codeVerifier: authRequest.codeVerifier,
        correlationId
      });

      const subject = (claims?.sub ?? userInfo?.sub ?? '') as string;
      if (!subject) {
        throw createAppError({
          caller: 'auth::completeOidcLogin',
          reason: 'OIDC callback did not provide a subject identifier.',
          errorKey: 'AUTH_OIDC_CALLBACK_FAILED',
          correlationId,
          status: 400
        });
      }

      const usernameCandidate = (
        (userInfo?.[oidcConfig.usernameClaim] as string | undefined)
        ?? (claims?.[oidcConfig.usernameClaim as keyof typeof claims] as string | undefined)
        ?? (claims?.preferred_username as string | undefined)
        ?? subject
      );
      const email = (
        (userInfo?.[oidcConfig.emailClaim] as string | undefined)
        ?? (claims?.[oidcConfig.emailClaim as keyof typeof claims] as string | undefined)
        ?? null
      );

      const user = await this.reconcileExternalUser({
        subject,
        username: usernameCandidate,
        email,
        correlationId
      });

      return {
        ...(await this.createSessionForUser({
          user,
          authMethod: 'oidc',
          sourceIp,
          userAgent,
          correlationId
        })),
        redirectTo: this.getSafePostLoginRedirectPath({ redirectTo: authRequest.redirectTo })
      };
    } catch (error) {
      await this.recordLoginAudit({
        authMethod: 'oidc',
        actor: null,
        sourceIp,
        correlationId,
        targetId: null,
        beforeSummary: {
          authMethod: 'oidc',
          state: state || null
        },
        commandResult: {
          errorKey: error instanceof AppError ? error.errorKey : null,
          failureReason: error instanceof Error ? error.message : 'OIDC login failed.'
        },
        success: false
      });

      throw error;
    }
  }

  private async reconcileExternalUser({
    subject,
    username,
    email,
    correlationId
  }: {
    subject: string;
    username: string;
    email: string | null;
    correlationId: string | null;
  }) {
    const normalizedUsername = normalizeUsername({ username });
    const bySubject = await this.db.getUserByExternalSubject({ subject });
    if (bySubject) {
      return await this.syncExternalAccount({
        user: bySubject,
        authSource: 'oidc',
        externalSubject: subject,
        email
      });
    }

    const byUsername = await this.db.getUserByUsername({ username: normalizedUsername });
    if (byUsername) {
      this.ensureAccountCanAutoLink({
        user: byUsername,
        authMethod: 'oidc',
        correlationId
      });

      return await this.syncExternalAccount({
        user: byUsername,
        authSource: 'oidc',
        externalSubject: subject,
        email
      });
    }

    const role = this.runtimeConfig.config.auth.oidc?.bootstrapAdminSubject === subject ? 'super_admin' : 'viewer';
    await this.createUser({
      username: normalizedUsername,
      email,
      password: null,
      role,
      authSource: 'oidc',
      externalSubject: subject,
      correlationId
    });

    const created = await this.db.getUserByUsername({ username: normalizedUsername });
    if (!created) {
      throw createAppError({
        caller: 'auth::reconcileExternalUser',
        reason: 'OIDC user creation failed.',
        errorKey: 'USER_CREATE_FAILED',
        correlationId
      });
    }

    return created;
  }

  async authenticateTrustedHeaders({
    sourceIp,
    headers,
    correlationId
  }: {
    sourceIp: string | null;
    headers: Headers;
    correlationId: string | null;
  }) {
    if (!this.runtimeConfig.config.auth.headerEnabled || !this.runtimeConfig.config.auth.header) {
      return null;
    }

    if (
      !sourceIp
      || !this.trustedProxyList.check(sourceIp)
    ) {
      return null;
    }

    for (const requiredHeader of this.runtimeConfig.config.auth.header.requiredHeaders) {
      if (!headers.get(requiredHeader)) {
        throw createAppError({
          caller: 'auth::authenticateTrustedHeaders',
          reason: `Trusted header ${requiredHeader} is missing.`,
          errorKey: 'AUTH_HEADER_INVALID',
          correlationId,
          status: 401
        });
      }
    }

    const usernameValue = headers.get(this.runtimeConfig.config.auth.header.usernameHeader);
    if (!usernameValue) return null;

    const normalizedUsername = normalizeUsername({ username: usernameValue });
    const existing = await this.db.getUserByUsername({ username: normalizedUsername });
    if (existing) {
      this.ensureAccountCanAutoLink({
        user: existing,
        authMethod: 'header',
        correlationId
      });

      const updated = await this.syncExternalAccount({
        user: existing,
        authSource: 'header',
        externalSubject: null,
        email: existing.email
      });

      return this.sanitizeUser({ user: updated });
    }

    await this.createUser({
      username: normalizedUsername,
      email: null,
      password: null,
      role: this.runtimeConfig.config.auth.header.defaultRole,
      authSource: 'header',
      externalSubject: null,
      correlationId
    });

    const created = await this.db.getUserByUsername({ username: normalizedUsername });
    return created ? this.sanitizeUser({ user: created }) : null;
  }

  async runMaintenance() {
    const now = new Date().toISOString();
    const authRequestCutoff = new Date(Date.now() - 15 * 60_000).toISOString();
    await Promise.all([
      this.db.purgeExpiredSessions({ now }),
      this.db.purgeOldAuthRequests({ olderThan: authRequestCutoff })
    ]);
  }
}

export const resolveSourceIp = ({ source }: { source: string | null | undefined }) => {
  if (!source) return null;
  return source.replace(/^::ffff:/, '');
};

export const createMaintenanceCorrelationId = () => createCorrelationId();
