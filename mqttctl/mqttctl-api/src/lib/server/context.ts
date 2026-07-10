import type { LoadedRuntimeConfig } from '$server/config/load';
import { loadRuntimeConfig } from '$server/config/load';
import { createLogger, generateLog, parseLoggerOptionsFromEnv, type AppLogger } from '$server/logging/logger';
import { AppDatabase } from '$server/db';
import { AuthService, createMaintenanceCorrelationId } from '$server/auth/service';
import { AuditService } from '$server/audit/service';
import { JobQueue } from '$server/jobs/queue';
import { DynsecService } from '$server/dynsec/service';
import { BrokerConfigService } from '$server/config/service';
import { SnapshotService } from '$server/snapshots/service';
import { DiagnosticsService } from '$server/diagnostics/service';
import { BrokerAgentClient } from '$server/broker-agent/client';
import { MqttExplorerService } from '$server/mqtt/service';
import { AppError } from '$server/logging/errors';
import { getControlPlaneBuildInfo, type BuildInfo } from '$server/build-info';

export interface AppContext {
  runtimeConfig: LoadedRuntimeConfig;
  logger: AppLogger;
  buildInfo: BuildInfo;
  db: AppDatabase;
  auth: AuthService;
  audit: AuditService;
  jobs: JobQueue;
  brokerAgent: BrokerAgentClient;
  dynsec: DynsecService;
  brokerConfig: BrokerConfigService;
  snapshots: SnapshotService;
  diagnostics: DiagnosticsService;
  mqtt: MqttExplorerService;
}

let appContextPromise: Promise<AppContext> | null = null;
let maintenanceTimerStarted = false;
const dynsecBootstrapRetryDelayMs = 1_000;
const dynsecBootstrapRetryAttempts = 30;
const dynsecBootstrapPendingMessage = 'Still setting things up.';

const enabledAuthModes = ({ runtimeConfig }: { runtimeConfig: LoadedRuntimeConfig }) => {
  const modes: string[] = [];

  if (runtimeConfig.config.auth.localEnabled) modes.push('local');
  if (runtimeConfig.config.auth.oidcEnabled) modes.push('oidc');
  if (runtimeConfig.config.auth.headerEnabled) modes.push('header');

  return modes;
};

const getOidcCallbackUrl = ({ runtimeConfig }: { runtimeConfig: LoadedRuntimeConfig }) => {
  const configuredCallbackUrl = runtimeConfig.config.auth.oidc?.callbackUrl;
  if (configuredCallbackUrl) return configuredCallbackUrl;

  return `${runtimeConfig.config.publicBaseUrl}${runtimeConfig.config.basePath}/auth/callback`;
};

const sleep = async ({ ms }: { ms: number }) => await new Promise<void>((resolve) => {
  setTimeout(() => {
    return resolve();
  }, ms);
});

const describeAppErrorForLog = ({ error }: { error: unknown }) => {
  if (!(error instanceof AppError)) {
    return {
      errorKey: null,
      errorCode: null,
      errorContext: null,
      errorChain: []
    };
  }

  return {
    errorKey: error.errorKey,
    errorCode: error.errorCode,
    errorContext: error.context ?? null,
    errorChain: error.errorChain
  };
};

const shouldRetryDynsecBootstrap = ({
  error,
  brokerAgentConfigured
}: {
  error: unknown;
  brokerAgentConfigured: boolean;
}) => (
  brokerAgentConfigured
  && error instanceof AppError
  && ['BROKER_AGENT_REQUEST_FAILED', 'DYNSEC_STATE_READ_FAILED'].includes(error.errorKey)
);

const logDynsecBootstrapRetry = ({
  logger,
  error,
  correlationId,
  attempt,
  maxAttempts,
  stage,
  brokerRunning
}: {
  logger: AppLogger;
  error: unknown;
  correlationId: string | null;
  attempt: number;
  maxAttempts: number;
  stage: 'health' | 'dynsec';
  brokerRunning?: boolean;
}) => {
  logger.warn({
    caller: 'context::dynsecBootstrap',
    message: `Default dynsec role bootstrap attempt ${attempt} is still setting things up. Retrying.`,
    ...(error instanceof AppError ? {
      errorKey: error.errorKey,
      errorCode: error.errorCode,
      errorChain: error.errorChain
    } : {}),
    correlationId,
    context: {
      attempt,
      maxAttempts,
      retryDelayMs: dynsecBootstrapRetryDelayMs,
      stage,
      ...(brokerRunning === undefined ? {} : { brokerRunning }),
      ...describeAppErrorForLog({ error })
    },
    rootCause: error
  });
};

const ensureDynsecBootstrapDefaultRole = async ({
  dynsec,
  brokerAgent,
  logger,
  correlationId
}: {
  dynsec: DynsecService;
  brokerAgent: BrokerAgentClient;
  logger: AppLogger;
  correlationId: string | null;
}) => {
  const brokerAgentConfigured = brokerAgent.isConfigured();
  const maxAttempts = brokerAgentConfigured ? dynsecBootstrapRetryAttempts : 1;
  dynsec.markBootstrapDefaultRolePending({ message: dynsecBootstrapPendingMessage });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (brokerAgentConfigured) {
      try {
        const health = await brokerAgent.readHealth({ correlationId });

        if (!health.brokerRunning) {
          if (attempt >= maxAttempts) {
            throw new AppError({
              caller: 'context::dynsecBootstrap',
              reason: 'Broker agent is reachable, but the broker is still not running.',
              errorKey: 'BROKER_AGENT_REQUEST_FAILED',
              correlationId,
              context: {
                attempt,
                maxAttempts,
                brokerRunning: health.brokerRunning,
                brokerPid: health.brokerPid
              }
            });
          }

          logDynsecBootstrapRetry({
            logger,
            error: new AppError({
              caller: 'context::dynsecBootstrap',
              reason: 'Broker agent is reachable, but the broker is still not running.',
              errorKey: 'BROKER_AGENT_REQUEST_FAILED',
              correlationId,
              context: {
                attempt,
                maxAttempts,
                brokerRunning: health.brokerRunning,
                brokerPid: health.brokerPid
              }
            }),
            correlationId,
            attempt,
            maxAttempts,
            stage: 'health',
            brokerRunning: health.brokerRunning
          });
          await sleep({ ms: dynsecBootstrapRetryDelayMs });
          continue;
        }
      } catch (error) {
        if (!shouldRetryDynsecBootstrap({ error, brokerAgentConfigured }) || attempt >= maxAttempts) {
          throw error;
        }

        logDynsecBootstrapRetry({
          logger,
          error,
          correlationId,
          attempt,
          maxAttempts,
          stage: 'health'
        });
        await sleep({ ms: dynsecBootstrapRetryDelayMs });
        continue;
      }
    }

    try {
      await dynsec.ensureBootstrapDefaultRole({ correlationId });
      dynsec.clearBootstrapDefaultRolePending();
      return;
    } catch (error) {
      if (!shouldRetryDynsecBootstrap({ error, brokerAgentConfigured }) || attempt >= maxAttempts) {
        throw error;
      }

      logDynsecBootstrapRetry({
        logger,
        error,
        correlationId,
        attempt,
        maxAttempts,
        stage: 'dynsec'
      });

      await sleep({ ms: dynsecBootstrapRetryDelayMs });
    }
  }
};

const logStartupDiagnostics = ({
  runtimeConfig,
  loggerOptions,
  logger,
  brokerAgent,
  correlationId,
  buildInfo
}: {
  runtimeConfig: LoadedRuntimeConfig;
  loggerOptions: ReturnType<typeof parseLoggerOptionsFromEnv>;
  logger: AppLogger;
  brokerAgent: BrokerAgentClient;
  correlationId: string | null;
  buildInfo: BuildInfo;
}) => {
  const authModes = enabledAuthModes({ runtimeConfig });
  const brokerAgentConfigured = brokerAgent.isConfigured();
  const oidcConfig = runtimeConfig.config.auth.oidcEnabled ? runtimeConfig.config.auth.oidc ?? null : null;
  const headerConfig = runtimeConfig.config.auth.headerEnabled ? runtimeConfig.config.auth.header ?? null : null;
  const oidcEndpointOverrides = oidcConfig
    ? [
        oidcConfig.authorizationEndpoint ? 'authorization' : null,
        oidcConfig.tokenEndpoint ? 'token' : null,
        oidcConfig.userinfoEndpoint ? 'userinfo' : null
      ].filter((value): value is string => Boolean(value))
    : [];
  const databaseContext = runtimeConfig.dbKind === 'sqlite'
    ? {
        kind: 'sqlite' as const,
        sqlitePath: runtimeConfig.sqlitePath
      }
    : {
        kind: 'postgres' as const,
        host: runtimeConfig.config.database.postgres!.host,
        port: runtimeConfig.config.database.postgres!.port,
        database: runtimeConfig.config.database.postgres!.database,
        user: runtimeConfig.config.database.postgres!.user,
        ssl: runtimeConfig.config.database.postgres!.ssl
      };

  generateLog({
    logger,
    level: 'info',
    caller: 'context::startup',
    message: `API build ${buildInfo.label}.`,
    correlationId,
    context: {
      build: {
        label: buildInfo.label,
        version: buildInfo.version,
        commitHash: buildInfo.commitHash
      }
    },
    sinks: {
      console: true,
      file: true,
      curl: true
    }
  });

  generateLog({
    logger,
    level: 'info',
    caller: 'context::startup',
    message: `API startup completed. auth=${authModes.join('+')} db=${runtimeConfig.dbKind} broker=${runtimeConfig.config.broker.host}:${runtimeConfig.config.broker.port} brokerAgent=${brokerAgentConfigured ? 'enabled' : 'disabled'} mqttTls=${runtimeConfig.config.broker.tls.enabled ? 'enabled' : 'disabled'} logging=console:${loggerOptions.consoleEnabled ? loggerOptions.consoleFormat : 'off'}/file:${loggerOptions.fileEnabled ? loggerOptions.fileFormat : 'off'}/curl:${loggerOptions.curlEnabled ? 'on' : 'off'}`,
    correlationId,
    context: {
      auth: {
        enabledModes: authModes,
        sessionTtlMinutes: runtimeConfig.config.auth.sessionTtlMinutes
      },
      database: databaseContext,
      broker: {
        host: runtimeConfig.config.broker.host,
        port: runtimeConfig.config.broker.port,
        brokerAgent: brokerAgentConfigured,
        tls: {
          enabled: runtimeConfig.config.broker.tls.enabled,
          insecure: runtimeConfig.config.broker.tls.insecure
        }
      },
      logging: {
        console: {
          enabled: loggerOptions.consoleEnabled,
          format: loggerOptions.consoleFormat,
          levels: loggerOptions.consoleLevels
        },
        file: {
          enabled: loggerOptions.fileEnabled,
          format: loggerOptions.fileFormat,
          levels: loggerOptions.fileLevels,
          pathConfigured: Boolean(loggerOptions.filePath)
        },
        curl: {
          enabled: loggerOptions.curlEnabled,
          levels: loggerOptions.curlLevels,
          method: loggerOptions.curlMethod,
          timeoutMs: loggerOptions.curlTimeoutMs,
          urlConfigured: Boolean(loggerOptions.curlUrl)
        },
        kubernetes: {
          enabled: loggerOptions.kubernetes.enabled,
          fields: Object.keys(
            Object.fromEntries(
              Object.entries({
                podName: loggerOptions.kubernetes.podName,
                deployment: loggerOptions.kubernetes.deployment,
                namespace: loggerOptions.kubernetes.namespace,
                podIp: loggerOptions.kubernetes.podIp,
                podIps: loggerOptions.kubernetes.podIps,
                nodeName: loggerOptions.kubernetes.nodeName
              }).filter(([, value]) => value !== undefined && value !== null && value !== '')
            )
          )
        }
      },
      ui: {
        publicBaseUrl: runtimeConfig.config.publicBaseUrl,
        basePath: runtimeConfig.config.basePath,
        httpApi: {
          mode: runtimeConfig.config.httpApi.mode,
          browserBasePath: runtimeConfig.config.httpApi.browserBasePath,
          proxyBasePath: runtimeConfig.config.httpApi.proxy.basePath,
          proxyUpstreamBaseUrlConfigured: Boolean(runtimeConfig.config.httpApi.proxy.upstreamBaseUrl),
          proxyUpstreamBasePath: runtimeConfig.config.httpApi.proxy.upstreamBasePath
        },
        uiOverrideCssPathConfigured: Boolean(runtimeConfig.uiOverrideCssPath),
        languageFilePathConfigured: Boolean(runtimeConfig.config.ui.languageFilePath)
      }
    },
    sinks: {
      console: true,
      file: true,
      curl: true
    }
  });

  generateLog({
    logger,
    level: 'info',
    caller: 'context::startup',
    message: `API auth diagnostics. sessionTtlMinutes=${runtimeConfig.config.auth.sessionTtlMinutes} oidc=${oidcConfig ? `enabled issuer=${oidcConfig.issuerUrl} callback=${getOidcCallbackUrl({ runtimeConfig })} tokenAuth=${oidcConfig.tokenEndpointAuthMethod} claims=${oidcConfig.usernameClaim}/${oidcConfig.emailClaim} endpointOverrides=${oidcEndpointOverrides.length ? oidcEndpointOverrides.join(',') : 'none'}` : 'disabled'} header=${headerConfig ? `enabled usernameHeader=${headerConfig.usernameHeader} groupsHeader=${headerConfig.groupsHeader ?? 'none'} trustedCidrs=${headerConfig.trustedCidrs.length} requiredHeaders=${headerConfig.requiredHeaders.length} defaultRole=${headerConfig.defaultRole}` : 'disabled'}`,
    correlationId,
    context: {
      auth: {
        localEnabled: runtimeConfig.config.auth.localEnabled,
        oidc: oidcConfig
          ? {
              issuerUrl: oidcConfig.issuerUrl,
              clientId: oidcConfig.clientId,
              callbackUrl: getOidcCallbackUrl({ runtimeConfig }),
              tokenEndpointAuthMethod: oidcConfig.tokenEndpointAuthMethod,
              authorizationEndpoint: oidcConfig.authorizationEndpoint,
              tokenEndpoint: oidcConfig.tokenEndpoint,
              userinfoEndpoint: oidcConfig.userinfoEndpoint,
              scopes: oidcConfig.scopes,
              usernameClaim: oidcConfig.usernameClaim,
              emailClaim: oidcConfig.emailClaim,
              bootstrapAdminSubjectConfigured: Boolean(oidcConfig.bootstrapAdminSubject)
            }
          : null,
        header: headerConfig
          ? {
              trustedCidrs: headerConfig.trustedCidrs,
              requiredHeaders: headerConfig.requiredHeaders,
              usernameHeader: headerConfig.usernameHeader,
              groupsHeader: headerConfig.groupsHeader,
              defaultRole: headerConfig.defaultRole
            }
          : null
      }
    },
    sinks: {
      console: true,
      file: true,
      curl: true
    }
  });

  generateLog({
    logger,
    level: 'info',
    caller: 'context::startup',
    message: `API broker diagnostics. dynsec=${brokerAgentConfigured ? 'broker-agent' : 'local-process'} rawConfigPath=${runtimeConfig.config.broker.mainConfigPath} commands=reload:${runtimeConfig.config.broker.reloadCommand ? 'configured' : 'disabled'},restart:${runtimeConfig.config.broker.restartCommand ? 'configured' : 'disabled'}`,
    correlationId,
    context: {
      broker: {
        host: runtimeConfig.config.broker.host,
        port: runtimeConfig.config.broker.port,
        mainConfigPath: runtimeConfig.config.broker.mainConfigPath,
        dynsecStateFilePath: runtimeConfig.config.broker.dynsecStateFilePath,
        dynsecAdminUsername: runtimeConfig.config.broker.dynsecAdminUsername,
        controlBinaryPath: runtimeConfig.config.broker.controlBinaryPath,
        brokerAgent: runtimeConfig.config.broker.agent
          ? {
              baseUrl: runtimeConfig.config.broker.agent.baseUrl,
              timeoutMs: runtimeConfig.config.broker.agent.timeoutMs,
              insecure: runtimeConfig.config.broker.agent.insecure
            }
          : null,
        keyFiles: {
          caFileConfigured: Boolean(runtimeConfig.config.broker.keyFiles.caFile),
          mosquittoPublicKeyConfigured: Boolean(runtimeConfig.config.broker.keyFiles.mosquittoPublicKey),
          brokerPublicKeyConfigured: Boolean(runtimeConfig.config.broker.keyFiles.brokerPublicKey)
        },
        tls: {
          enabled: runtimeConfig.config.broker.tls.enabled,
          insecure: runtimeConfig.config.broker.tls.insecure,
          caFileConfigured: Boolean(runtimeConfig.config.broker.tls.caFile),
          certFileConfigured: Boolean(runtimeConfig.config.broker.tls.certFile),
          keyFileConfigured: Boolean(runtimeConfig.config.broker.tls.keyFile)
        },
        commands: {
          reloadConfigured: Boolean(runtimeConfig.config.broker.reloadCommand),
          restartConfigured: Boolean(runtimeConfig.config.broker.restartCommand)
        }
      }
    },
    sinks: {
      console: true,
      file: true,
      curl: true
    }
  });
};

const logBrokerAgentRuntimeInfo = async ({
  runtimeConfig,
  logger,
  audit,
  brokerAgent,
  correlationId
}: {
  runtimeConfig: LoadedRuntimeConfig;
  logger: AppLogger;
  audit: AuditService;
  brokerAgent: BrokerAgentClient;
  correlationId: string | null;
}) => {
  if (!brokerAgent.isConfigured()) return;

  const auditCorrelationId = correlationId ?? createMaintenanceCorrelationId();
  const baseUrl = runtimeConfig.config.broker.agent?.baseUrl ?? null;
  const maxAttempts = dynsecBootstrapRetryAttempts;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const runtimeInfo = await brokerAgent.readRuntime({ correlationId });
      const versionContext = {
        baseUrl,
        agent: {
          version: runtimeInfo.brokerAgentVersion,
          buildHash: runtimeInfo.brokerAgentBuildHash
        },
        broker: {
          mqttServerVersion: runtimeInfo.mqttServerVersion
        },
        brokerAgent: {
          baseUrl,
          ...runtimeInfo
        }
      };

      generateLog({
        logger,
        level: 'info',
        caller: 'context::brokerAgentRuntime',
        message: `Connected to broker agent ${runtimeInfo.brokerAgentVersion ?? 'unknown'} (${runtimeInfo.brokerAgentBuildHash ?? 'unknown'}).`,
        correlationId,
        context: versionContext,
        sinks: {
          console: true,
          file: true,
          curl: true
        }
      });

      await audit.record({
        actor: null,
        authMode: null,
        sourceIp: null,
        correlationId: auditCorrelationId,
        action: 'broker_agent.connect',
        targetType: 'broker_agent',
        targetId: baseUrl,
        afterSummary: versionContext,
        commandResult: {
          connected: true,
          runtime: runtimeInfo
        },
        success: true
      });
      return;
    } catch (error) {
      if (attempt < maxAttempts) {
        await sleep({ ms: dynsecBootstrapRetryDelayMs });
        continue;
      }

      logger.warn({
        caller: 'context::brokerAgentRuntime',
        message: 'Broker agent runtime metadata could not be read.',
        ...(error instanceof AppError ? {
          errorKey: error.errorKey,
          errorCode: error.errorCode,
          errorChain: error.errorChain
        } : {}),
        correlationId,
        context: {
          baseUrl,
          attempt,
          maxAttempts,
          retryDelayMs: dynsecBootstrapRetryDelayMs
        },
        rootCause: error
      });
    }
  }
};

const createContext = async ({ correlationId }: { correlationId: string | null }) => {
  const runtimeConfig = await loadRuntimeConfig({ correlationId });
  const loggerOptions = parseLoggerOptionsFromEnv({ config: runtimeConfig.config.logging });
  const logger = createLogger({ options: loggerOptions });
  const buildInfo = getControlPlaneBuildInfo();
  const db = new AppDatabase({
    config: runtimeConfig.dbKind === 'sqlite'
      ? {
          kind: 'sqlite',
          sqlitePath: runtimeConfig.sqlitePath
        }
      : {
          kind: 'postgres',
          sqlitePath: runtimeConfig.sqlitePath,
          postgres: {
            host: runtimeConfig.config.database.postgres!.host,
            port: runtimeConfig.config.database.postgres!.port,
            database: runtimeConfig.config.database.postgres!.database,
            user: runtimeConfig.config.database.postgres!.user,
            password: runtimeConfig.secrets.postgresPassword!,
            ssl: runtimeConfig.config.database.postgres!.ssl
          }
        }
  });

  await db.initialize({ correlationId });

  const jobs = new JobQueue();
  const audit = new AuditService(db, logger);
  const auth = new AuthService(db, runtimeConfig, logger, audit);
  const brokerAgent = new BrokerAgentClient(runtimeConfig, logger);
  const dynsec = new DynsecService(db, runtimeConfig, logger, brokerAgent);
  const brokerConfig = new BrokerConfigService(db, runtimeConfig, logger, brokerAgent);
  const snapshots = new SnapshotService(db, buildInfo.label, dynsec, brokerConfig);
  const diagnostics = new DiagnosticsService(db, runtimeConfig, dynsec, brokerConfig, brokerAgent);
  const mqtt = new MqttExplorerService(runtimeConfig, logger);

  await auth.bootstrapInitialAdmin({ correlationId });
  void logBrokerAgentRuntimeInfo({
    runtimeConfig,
    logger,
    audit,
    brokerAgent,
    correlationId
  });
  void ensureDynsecBootstrapDefaultRole({
    dynsec,
    brokerAgent,
    logger,
    correlationId
  }).catch((error) => {
    const bootstrapError = dynsec.getBootstrapDefaultRoleError();
    dynsec.markBootstrapDefaultRoleFailed({
      message: bootstrapError?.reason ?? (error instanceof Error ? error.message : 'Default dynsec role bootstrap failed.')
    });
    logger.warn({
      caller: 'context::dynsecBootstrap',
      message: 'Default dynsec role bootstrap failed.',
      ...(error instanceof AppError ? {
        errorKey: error.errorKey,
        errorCode: error.errorCode,
        errorChain: error.errorChain
      } : {}),
      correlationId,
      context: describeAppErrorForLog({ error }),
      rootCause: error
    });
  });

  logStartupDiagnostics({ runtimeConfig, loggerOptions, logger, brokerAgent, correlationId, buildInfo });

  await audit.record({
    actor: null,
    authMode: null,
    sourceIp: null,
    correlationId: correlationId ?? createMaintenanceCorrelationId(),
    action: 'app.startup',
    targetType: 'app_runtime',
    targetId: buildInfo.label,
    afterSummary: {
      build: buildInfo.label,
      authModes: enabledAuthModes({ runtimeConfig }),
      dbKind: runtimeConfig.dbKind,
      broker: {
        host: runtimeConfig.config.broker.host,
        port: runtimeConfig.config.broker.port,
        brokerAgent: brokerAgent.isConfigured()
      }
    },
    commandResult: {
      started: true
    },
    success: true
  });

  if (!maintenanceTimerStarted) {
    maintenanceTimerStarted = true;
    setInterval(() => {
      const maintenanceCorrelationId = createMaintenanceCorrelationId();
      void auth.runMaintenance().catch((error) => {
        logger.error({
          caller: 'context::maintenance',
          message: 'Auth maintenance failed.',
          correlationId: maintenanceCorrelationId,
          errorKey: 'APP_STARTUP_FAILED',
          rootCause: error
        });
      });
    }, 60_000);
  }

  return {
    runtimeConfig,
    logger,
    buildInfo,
    db,
    auth,
    audit,
    jobs,
    brokerAgent,
    dynsec,
    brokerConfig,
    snapshots,
    diagnostics,
    mqtt
  } satisfies AppContext;
};

export const getAppContext = async ({ correlationId = null }: { correlationId?: string | null } = {}) => {
  if (!appContextPromise) {
    appContextPromise = createContext({ correlationId });
  }

  return await appContextPromise;
};
