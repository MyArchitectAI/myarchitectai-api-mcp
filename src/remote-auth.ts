import type { IncomingMessage } from 'node:http';
import { performance } from 'node:perf_hooks';
import { createRemoteJWKSet, errors, jwtVerify,
  type JWTVerifyGetKey } from 'jose';
import { ConfigError } from './errors.js';
import { logEvent } from './logger.js';
import type { ValidatedRemoteHttpConfig } from './remote-config.js';

export type VerifiedIdentity = { issuer: string; subject: string; clientId: string };

export class RemoteAuthenticationError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'RemoteAuthenticationError';
  }
}

export class RemoteAuthenticationUnavailableError extends Error {
  constructor() {
    super('Authentication unavailable');
    this.name = 'RemoteAuthenticationUnavailableError';
  }
}

export const createRemoteAuthenticator = (
  config: ValidatedRemoteHttpConfig,
  injectedJwks?: JWTVerifyGetKey,
  emit: typeof logEvent = logEvent,
): ((request: IncomingMessage) => Promise<VerifiedIdentity>) => {
  if (!injectedJwks && !config.jwksUrl) {
    throw new ConfigError('A trusted jwksUrl or injected JWKS verifier is required');
  }
  const jwks = injectedJwks ?? createRemoteJWKSet(config.jwksUrl as URL, { timeoutDuration: 5_000 });
  // The resolver may use a cached key; this event never claims an HTTP request occurred.
  const resolvingJwks: JWTVerifyGetKey = async (...args) => {
    const started = performance.now();
    try {
      const key = await jwks(...args);
      emit({ event: 'remote_jwks_key_resolution', vendor: 'supabase_jwks',
        operation: 'resolve_signing_key', outcome: 'ok', duration_ms: Math.round(performance.now() - started) });
      return key;
    } catch (error) {
      const invalidKeySelection = error instanceof errors.JWKSNoMatchingKey ||
        error instanceof errors.JWKSMultipleMatchingKeys;
      emit({ event: 'remote_jwks_key_resolution', vendor: 'supabase_jwks',
        operation: 'resolve_signing_key', outcome: invalidKeySelection ? 'client_error' : 'server_error',
        duration_ms: Math.round(performance.now() - started),
        ...(invalidKeySelection ? {} : { fingerprint: 'remote.auth.resolve_signing_key' }) });
      if (invalidKeySelection) {
        throw error;
      }
      throw new RemoteAuthenticationUnavailableError();
    }
  };
  return async (request) => {
    const headerCount = request.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === 'authorization').length;
    const authorization = request.headers.authorization;
    const match = headerCount === 1 && typeof authorization === 'string'
      ? /^Bearer ([A-Za-z0-9_\-.~+/]+=*)$/.exec(authorization)
      : null;
    if (!match) {
      throw new RemoteAuthenticationError();
    }
    try {
      const { payload } = await jwtVerify(match[1] as string, resolvingJwks, {
        issuer: config.issuer,
        audience: config.canonicalResource,
        algorithms: ['ES256', 'RS256'],
        requiredClaims: ['exp', 'sub', 'client_id'],
      });
      if (payload.aud !== config.canonicalResource || typeof payload.sub !== 'string' ||
          !payload.sub.trim() || payload.sub !== payload.sub.trim() ||
          typeof payload.client_id !== 'string' || !payload.client_id.trim() ||
          payload.client_id !== payload.client_id.trim()) {
        throw new RemoteAuthenticationError();
      }
      return { issuer: config.issuer, subject: payload.sub, clientId: payload.client_id };
    } catch (error) {
      if (error instanceof RemoteAuthenticationUnavailableError) {
        throw error;
      }
      throw new RemoteAuthenticationError();
    }
  };
};
