import type { IncomingMessage } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { ConfigError } from './errors.js';
import type { ValidatedRemoteHttpConfig } from './remote-config.js';

export type VerifiedIdentity = { issuer: string; subject: string; clientId: string };

export class RemoteAuthenticationError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'RemoteAuthenticationError';
  }
}

export const createRemoteAuthenticator = (
  config: ValidatedRemoteHttpConfig,
  injectedJwks?: JWTVerifyGetKey,
): ((request: IncomingMessage) => Promise<VerifiedIdentity>) => {
  if (!injectedJwks && !config.jwksUrl) {
    throw new ConfigError('A trusted jwksUrl or injected JWKS verifier is required');
  }
  const jwks = injectedJwks ?? createRemoteJWKSet(config.jwksUrl as URL, { timeoutDuration: 5_000 });
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
      const { payload } = await jwtVerify(match[1] as string, jwks, {
        issuer: config.issuer,
        audience: config.canonicalResource,
        algorithms: ['ES256', 'RS256'],
        requiredClaims: ['exp', 'sub', 'client_id'],
      });
      if (payload.aud !== config.canonicalResource || typeof payload.sub !== 'string' ||
          !payload.sub.trim() || payload.sub !== payload.sub.trim() ||
          typeof payload.client_id !== 'string' || !config.allowedOAuthClientIds.has(payload.client_id)) {
        throw new RemoteAuthenticationError();
      }
      return { issuer: config.issuer, subject: payload.sub, clientId: payload.client_id };
    } catch {
      throw new RemoteAuthenticationError();
    }
  };
};
