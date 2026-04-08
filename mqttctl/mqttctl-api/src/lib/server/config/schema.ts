import { z } from 'zod';
import { authMethods, managedBrokerKeyFileIds, userRoles } from '$lib/types';

const commandArraySchema = z.array(z.string().min(1)).min(1);

const authMethodEnum = z.enum(authMethods);
const userRoleEnum = z.enum(userRoles);
const logLevelEnum = z.enum(['debug', 'info', 'warn', 'error']);
const logFormatEnum = z.enum(['text', 'json']);
const logLevelListSchema = z.array(logLevelEnum).min(1);
const oidcTokenEndpointAuthMethodEnum = z.enum(['client_secret_post', 'client_secret_basic']);
const managedBrokerKeyFilePathSchema = z.record(
  z.enum(managedBrokerKeyFileIds),
  z.string().min(1).nullable()
);

const authEventLoggingSchema = z.object({
  level: logLevelEnum.default('info'),
  console: z.boolean().default(true),
  file: z.boolean().default(false),
  curl: z.boolean().default(false)
});

const loggingKubernetesSchema = z.object({
  enabled: z.boolean().default(false),
  podName: z.string().min(1).nullable().default(null),
  deployment: z.string().min(1).nullable().default(null),
  namespace: z.string().min(1).nullable().default(null),
  podIp: z.string().min(1).nullable().default(null),
  podIps: z.string().min(1).nullable().default(null),
  nodeName: z.string().min(1).nullable().default(null)
}).default({
  enabled: false,
  podName: null,
  deployment: null,
  namespace: null,
  podIp: null,
  podIps: null,
  nodeName: null
});

const loggingSchema = z.object({
  includeCorrelationId: z.boolean().default(true),
  includeUserAgent: z.boolean().default(true),
  includeNormalizedUsername: z.boolean().default(true),
  includeSessionExpiry: z.boolean().default(true),
  sinks: z.object({
    console: z.object({
      enabled: z.boolean().default(true),
      levels: logLevelListSchema.default(['info', 'warn', 'error']),
      format: logFormatEnum.default('text')
    }).default({
      enabled: true,
      levels: ['info', 'warn', 'error'],
      format: 'text'
    }),
    file: z.object({
      enabled: z.boolean().default(false),
      levels: logLevelListSchema.default(['info', 'warn', 'error']),
      format: logFormatEnum.default('json'),
      path: z.string().min(1).nullable().default(null)
    }).default({
      enabled: false,
      levels: ['info', 'warn', 'error'],
      format: 'json',
      path: null
    }),
    curl: z.object({
      enabled: z.boolean().default(false),
      levels: logLevelListSchema.default(['error']),
      url: z.string().url().nullable().default(null),
      method: z.string().min(1).default('POST'),
      timeoutMs: z.number().int().positive().default(2500)
    }).default({
      enabled: false,
      levels: ['error'],
      url: null,
      method: 'POST',
      timeoutMs: 2500
    })
  }).default({
    console: {
      enabled: true,
      levels: ['info', 'warn', 'error'],
      format: 'text'
    },
    file: {
      enabled: false,
      levels: ['info', 'warn', 'error'],
      format: 'json',
      path: null
    },
    curl: {
      enabled: false,
      levels: ['error'],
      url: null,
      method: 'POST',
      timeoutMs: 2500
    }
  }),
  kubernetes: loggingKubernetesSchema,
  failedLoginAttempts: authEventLoggingSchema.extend({
    level: logLevelEnum.default('warn')
  }).nullable().default(null),
  successfulLogin: authEventLoggingSchema.extend({
    level: logLevelEnum.default('info')
  }).nullable().default(null)
}).superRefine((value, context) => {
  if (value.sinks.file.enabled && !value.sinks.file.path) {
    context.addIssue({
      code: 'custom',
      message: 'logging.sinks.file.path is required when the file sink is enabled.',
      path: ['sinks', 'file', 'path']
    });
  }

  if (value.sinks.curl.enabled && !value.sinks.curl.url) {
    context.addIssue({
      code: 'custom',
      message: 'logging.sinks.curl.url is required when the curl sink is enabled.',
      path: ['sinks', 'curl', 'url']
    });
  }
});

export const configSchema = z.object({
  appName: z.string().default('mqttctl'),
  publicBaseUrl: z.string().url(),
  basePath: z.string().default(''),
  ui: z.object({
    defaultTheme: z.enum(['dark', 'light']).default('dark'),
    defaultFont: z.string().default('ui-mono'),
    languageFilePath: z.string().min(1).nullable().default(null),
    dynsec: z.object({
      showAssignmentPriorities: z.boolean().default(false)
    }).default({
      showAssignmentPriorities: false
    })
  }).default({
    defaultTheme: 'dark',
    defaultFont: 'ui-mono',
    languageFilePath: null,
    dynsec: {
      showAssignmentPriorities: false
    }
  }),
  logging: loggingSchema.default({
    includeCorrelationId: true,
    includeUserAgent: true,
    includeNormalizedUsername: true,
    includeSessionExpiry: true,
    sinks: {
      console: {
        enabled: true,
        levels: ['info', 'warn', 'error'],
        format: 'text'
      },
      file: {
        enabled: false,
        levels: ['info', 'warn', 'error'],
        format: 'json',
        path: null
      },
      curl: {
        enabled: false,
        levels: ['error'],
        url: null,
        method: 'POST',
        timeoutMs: 2500
      }
    },
    kubernetes: {
      enabled: false,
      podName: null,
      deployment: null,
      namespace: null,
      podIp: null,
      podIps: null,
      nodeName: null
    },
    failedLoginAttempts: null,
    successfulLogin: null
  }),
  auth: z.object({
    localEnabled: z.boolean().default(true),
    oidcEnabled: z.boolean().default(false),
    headerEnabled: z.boolean().default(false),
    sessionTtlMinutes: z.number().int().positive().default(1440),
    oidc: z.object({
      issuerUrl: z.string().url(),
      clientId: z.string().min(1),
      tokenEndpointAuthMethod: oidcTokenEndpointAuthMethodEnum.default('client_secret_post'),
      callbackUrl: z.string().url().nullable().default(null),
      authorizationEndpoint: z.string().url().nullable().default(null),
      tokenEndpoint: z.string().url().nullable().default(null),
      userinfoEndpoint: z.string().url().nullable().default(null),
      scopes: z.array(z.string().min(1)).default(['openid', 'profile', 'email']),
      usernameClaim: z.string().default('preferred_username'),
      emailClaim: z.string().default('email'),
      bootstrapAdminSubject: z.string().min(1).nullable().default(null)
    }).optional(),
    header: z.object({
      trustedCidrs: z.array(z.string().min(1)).default([]),
      requiredHeaders: z.array(z.string().min(1)).default([]),
      usernameHeader: z.string().default('x-auth-request-user'),
      groupsHeader: z.string().nullable().default(null),
      defaultRole: userRoleEnum.default('viewer')
    }).optional()
  }).superRefine((value, context) => {
    if (value.headerEnabled && value.oidcEnabled) {
      context.addIssue({
        code: 'custom',
        message: 'Header auth and OIDC cannot both be enabled.',
        path: ['headerEnabled']
      });
    }

    if (value.localEnabled || value.headerEnabled || value.oidcEnabled) return;

    context.addIssue({
      code: 'custom',
      message: 'At least one auth mode must be enabled.',
      path: ['localEnabled']
    });
  }),
  database: z.object({
    postgres: z.object({
      host: z.string().min(1),
      port: z.number().int().positive().default(5432),
      database: z.string().min(1),
      user: z.string().min(1),
      ssl: z.boolean().default(false)
    }).optional()
  }).default({}),
  broker: z.object({
    host: z.string().min(1),
    port: z.number().int().positive().default(1883),
    dynsecAdminUsername: z.string().min(1).default('admin'),
    controlBinaryPath: z.string().min(1).default('mosquitto_ctrl'),
    agent: z.object({
      baseUrl: z.string().url(),
      timeoutMs: z.number().int().positive().default(60_000),
      insecure: z.boolean().default(false)
    }).optional(),
    dynsecStateFilePath: z.string().min(1),
    mainConfigPath: z.string().min(1),
    keyFiles: managedBrokerKeyFilePathSchema.default({
      caFile: null,
      mosquittoPublicKey: null,
      brokerPublicKey: null
    }),
    reloadCommand: commandArraySchema.optional(),
    restartCommand: commandArraySchema.optional(),
    mqttClientId: z.string().min(1).default('mqttctl-admin'),
    tls: z.object({
      enabled: z.boolean().default(false),
      caFile: z.string().nullable().default(null),
      certFile: z.string().nullable().default(null),
      keyFile: z.string().nullable().default(null),
      insecure: z.boolean().default(false)
    }).default({
      enabled: false,
      caFile: null,
      certFile: null,
      keyFile: null,
      insecure: false
    })
  })
});

export const secretsSchema = z.object({
  sessionSecret: z.string().min(16),
  oidcClientSecret: z.string().min(1).nullable().default(null),
  postgresPassword: z.string().min(1).nullable().default(null),
  broker: z.object({
    dynsecAdminPassword: z.string().min(1),
    agentApiKey: z.string().min(1).nullable().default(null)
  }),
  bootstrapAdmin: z.object({
    username: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    email: z.string().email().optional()
  }).optional()
});

export type RuntimeConfig = z.infer<typeof configSchema>;
export type RuntimeSecrets = z.infer<typeof secretsSchema>;
export type RuntimeAuthMethod = z.infer<typeof authMethodEnum>;
