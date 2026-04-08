import * as oidc from 'openid-client';
import { createAppError } from '$server/logging/errors';

let cachedConfiguration: oidc.Configuration | null = null;
let cachedConfigurationKey: string | null = null;

type OidcTokenEndpointAuthMethod = 'client_secret_post' | 'client_secret_basic';

const normalizeIssuerUrl = ({ issuerUrl }: { issuerUrl: string }) => issuerUrl.replace(/\/+$/, '');

const getClientAuthentication = ({
  tokenEndpointAuthMethod,
  clientSecret
}: {
  tokenEndpointAuthMethod: OidcTokenEndpointAuthMethod;
  clientSecret: string;
}) => (
  tokenEndpointAuthMethod === 'client_secret_basic'
    ? oidc.ClientSecretBasic(clientSecret)
    : oidc.ClientSecretPost(clientSecret)
);

const summarizeCause = (value: unknown) => {
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  const summary: Record<string, unknown> = {};

  if (typeof record.code === 'string') summary.code = record.code;
  if (typeof record.error === 'string') summary.error = record.error;
  if (typeof record.error_description === 'string') summary.errorDescription = record.error_description;
  if (typeof record.status === 'number') summary.status = record.status;
  if (typeof record.attribute === 'string') summary.attribute = record.attribute;
  if (typeof record.message === 'string') summary.message = record.message;

  return Object.keys(summary).length ? summary : null;
};

const getOidcErrorContext = ({ error }: { error: unknown }) => {
  if (!(error instanceof Error)) return null;

  const summary: Record<string, unknown> = {
    name: error.name,
    message: error.message
  };
  const record = error as Error & Record<string, unknown>;

  if (typeof record.code === 'string') summary.code = record.code;

  const causeSummary = summarizeCause(record.cause);
  if (causeSummary) summary.cause = causeSummary;

  return summary;
};

const loadDiscoveredServerMetadata = async ({
  issuerUrl,
  correlationId
}: {
  issuerUrl: string;
  correlationId: string | null;
}) => {
  const wellKnownUrl = `${normalizeIssuerUrl({ issuerUrl })}/.well-known/openid-configuration`;

  try {
    const response = await fetch(wellKnownUrl, {
      headers: {
        accept: 'application/json'
      }
    });
    const text = await response.text();

    if (!response.ok) {
      throw createAppError({
        caller: 'auth::oidc::discovery',
        reason: 'OIDC discovery failed.',
        errorKey: 'AUTH_OIDC_DISCOVERY_FAILED',
        correlationId,
        context: {
          issuerUrl,
          wellKnownUrl,
          status: response.status,
          responseBody: text.slice(0, 500)
        }
      });
    }

    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('OIDC discovery document must be a JSON object.');
    }

    return parsed as oidc.ServerMetadata;
  } catch (error) {
    if (error instanceof Error && 'errorKey' in error) {
      throw error;
    }

    throw createAppError({
      caller: 'auth::oidc::discovery',
      reason: 'OIDC discovery failed.',
      errorKey: 'AUTH_OIDC_DISCOVERY_FAILED',
      correlationId,
      context: { issuerUrl, wellKnownUrl },
      cause: error
    });
  }
};

export const getOidcConfiguration = async ({
  issuerUrl,
  clientId,
  clientSecret,
  tokenEndpointAuthMethod,
  authorizationEndpoint,
  tokenEndpoint,
  userinfoEndpoint,
  correlationId
}: {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  tokenEndpointAuthMethod: OidcTokenEndpointAuthMethod;
  authorizationEndpoint?: string | null;
  tokenEndpoint?: string | null;
  userinfoEndpoint?: string | null;
  correlationId: string | null;
}) => {
  const configurationKey = JSON.stringify({
    issuerUrl,
    clientId,
    tokenEndpointAuthMethod,
    authorizationEndpoint: authorizationEndpoint ?? null,
    tokenEndpoint: tokenEndpoint ?? null,
    userinfoEndpoint: userinfoEndpoint ?? null
  });

  if (cachedConfiguration && cachedConfigurationKey === configurationKey) {
    return cachedConfiguration;
  }

  try {
    const discoveredMetadata = await loadDiscoveredServerMetadata({ issuerUrl, correlationId });
    const discoveredIssuerUrl = typeof discoveredMetadata.issuer === 'string'
      ? discoveredMetadata.issuer
      : null;

    if (
      discoveredIssuerUrl
      && normalizeIssuerUrl({ issuerUrl: discoveredIssuerUrl }) !== normalizeIssuerUrl({ issuerUrl })
    ) {
      throw createAppError({
        caller: 'auth::oidc::discovery',
        reason: 'OIDC discovery issuer did not match the configured issuer URL.',
        errorKey: 'AUTH_OIDC_DISCOVERY_FAILED',
        correlationId,
        context: {
          issuerUrl,
          discoveredIssuerUrl
        }
      });
    }

    const serverMetadata: oidc.ServerMetadata = {
      ...discoveredMetadata,
      issuer: discoveredIssuerUrl ?? issuerUrl,
      authorization_endpoint: authorizationEndpoint ?? discoveredMetadata.authorization_endpoint,
      token_endpoint: tokenEndpoint ?? discoveredMetadata.token_endpoint,
      userinfo_endpoint: userinfoEndpoint ?? discoveredMetadata.userinfo_endpoint
    };

    cachedConfiguration = new oidc.Configuration(
      serverMetadata,
      clientId,
      { client_secret: clientSecret },
      getClientAuthentication({ tokenEndpointAuthMethod, clientSecret })
    );
    cachedConfigurationKey = configurationKey;
    return cachedConfiguration;
  } catch (error) {
    if (error instanceof Error && 'errorKey' in error) {
      throw error;
    }

    throw createAppError({
      caller: 'auth::oidc::discovery',
      reason: 'OIDC discovery failed.',
      errorKey: 'AUTH_OIDC_DISCOVERY_FAILED',
      correlationId,
      context: {
        issuerUrl,
        tokenEndpointAuthMethod,
        authorizationEndpoint: authorizationEndpoint ?? null,
        tokenEndpoint: tokenEndpoint ?? null,
        userinfoEndpoint: userinfoEndpoint ?? null
      },
      cause: error
    });
  }
};

export const createOidcAuthorizationUrl = async ({
  issuerUrl,
  clientId,
  clientSecret,
  tokenEndpointAuthMethod,
  authorizationEndpoint,
  tokenEndpoint,
  userinfoEndpoint,
  redirectUri,
  scope,
  correlationId
}: {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  tokenEndpointAuthMethod: OidcTokenEndpointAuthMethod;
  authorizationEndpoint?: string | null;
  tokenEndpoint?: string | null;
  userinfoEndpoint?: string | null;
  redirectUri: string;
  scope: string;
  correlationId: string | null;
}) => {
  const configuration = await getOidcConfiguration({
    issuerUrl,
    clientId,
    clientSecret,
    tokenEndpointAuthMethod,
    authorizationEndpoint,
    tokenEndpoint,
    userinfoEndpoint,
    correlationId
  });
  const state = oidc.randomState();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const redirectUrl = oidc.buildAuthorizationUrl(configuration, {
    redirect_uri: redirectUri,
    scope,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state
  });

  return {
    configuration,
    state,
    codeVerifier,
    redirectUrl
  };
};

export const exchangeOidcCallback = async ({
  issuerUrl,
  clientId,
  clientSecret,
  tokenEndpointAuthMethod,
  authorizationEndpoint,
  tokenEndpoint,
  userinfoEndpoint,
  redirectUri,
  callbackUrl,
  expectedState,
  codeVerifier,
  correlationId
}: {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  tokenEndpointAuthMethod: OidcTokenEndpointAuthMethod;
  authorizationEndpoint?: string | null;
  tokenEndpoint?: string | null;
  userinfoEndpoint?: string | null;
  redirectUri: string;
  callbackUrl: URL;
  expectedState: string;
  codeVerifier: string;
  correlationId: string | null;
}) => {
  const configuration = await getOidcConfiguration({
    issuerUrl,
    clientId,
    clientSecret,
    tokenEndpointAuthMethod,
    authorizationEndpoint,
    tokenEndpoint,
    userinfoEndpoint,
    correlationId
  });

  // openid-client derives the token request redirect_uri from the callback URL it receives.
  // Behind reverse proxies or dev servers, the runtime callback origin may differ from the
  // configured public callback even when the query parameters are valid. Rebuild a callback URL
  // from the configured redirect URI so the token exchange uses the registered redirect_uri.
  const exchangeCallbackUrl = new URL(redirectUri);
  exchangeCallbackUrl.search = callbackUrl.search;

  try {
    const tokens = await oidc.authorizationCodeGrant(configuration, exchangeCallbackUrl, {
      expectedState,
      pkceCodeVerifier: codeVerifier
    }, { redirect_uri: redirectUri });

    const claims = tokens.claims();
    const subject = claims?.sub ?? '';
    const userInfo = tokens.access_token
      ? await oidc.fetchUserInfo(configuration, tokens.access_token, subject || oidc.skipSubjectCheck)
      : null;

    return {
      claims,
      userInfo
    };
  } catch (error) {
    throw createAppError({
      caller: 'auth::oidc::callback',
      reason: 'OIDC callback exchange failed.',
      errorKey: 'AUTH_OIDC_CALLBACK_FAILED',
      correlationId,
      context: {
        redirectUri,
        callbackUrl: callbackUrl.href,
        exchangeCallbackUrl: exchangeCallbackUrl.href,
        tokenEndpointAuthMethod,
        callback: {
          hasCode: callbackUrl.searchParams.has('code'),
          hasState: callbackUrl.searchParams.has('state'),
          issuer: callbackUrl.searchParams.get('iss'),
          error: callbackUrl.searchParams.get('error'),
          errorDescription: callbackUrl.searchParams.get('error_description')
        },
        oidcError: getOidcErrorContext({ error })
      },
      cause: error
    });
  }
};
