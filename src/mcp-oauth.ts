import { createHmac } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { jwtVerify } from 'jose';
import { RemoteAuthenticationError, type VerifiedIdentity } from './remote-auth.js';

export const MCP_SCOPES = ['render:interior', 'render:exterior', 'text-to-image', 'edit-by-prompt',
  'change-textures', 'set-atmosphere', 'style-transfer', 'upscale', 'upscale-4k', 'animate', 'auto-prompt', 'balance:read'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const mcpAccessSigningKey = (secret: string): Buffer =>
  createHmac('sha256', secret).update('mcp-oauth-access-v1').digest();

export const createMcpOAuthAuthenticator = (config: { issuer: string; canonicalResource: string; signingSecret: string }):
  ((request: IncomingMessage) => Promise<VerifiedIdentity>) => async (request) => {
  try {
    const count = request.rawHeaders.filter((key, index) => index % 2 === 0 && key.toLowerCase() === 'authorization').length;
    const header = request.headers.authorization;
    const match = count === 1 && typeof header === 'string' ? /^Bearer ([A-Za-z0-9_.-]+)$/.exec(header) : null;
    const token = match?.[1];
    if (!token || token.length > 4096) {throw new RemoteAuthenticationError();}
    const { payload, protectedHeader } = await jwtVerify(token, mcpAccessSigningKey(config.signingSecret), {
      algorithms: ['HS256'], typ: 'mcp-access+jwt', issuer: config.issuer, audience: config.canonicalResource,
      requiredClaims: ['sub', 'client_id', 'grant_id', 'scope', 'iat', 'exp', 'jti'], maxTokenAge: 900,
    });
    const allowed = ['iss', 'aud', 'sub', 'client_id', 'grant_id', 'scope', 'iat', 'exp', 'jti'];
    if (Object.keys(payload).some((key) => !allowed.includes(key)) ||
        Object.keys(protectedHeader).some((key) => !['alg', 'typ'].includes(key)) ||
        payload.aud !== config.canonicalResource || typeof payload.sub !== 'string' || !UUID.test(payload.sub) ||
        typeof payload.client_id !== 'string' || !UUID.test(payload.client_id) ||
        typeof payload.grant_id !== 'string' || !UUID.test(payload.grant_id) ||
        typeof payload.jti !== 'string' || !UUID.test(payload.jti) ||
        typeof payload.iat !== 'number' || typeof payload.exp !== 'number' ||
        !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) ||
        payload.exp <= payload.iat || payload.exp > payload.iat + 900 || typeof payload.scope !== 'string') {
      throw new RemoteAuthenticationError();
    }
    const scopes = payload.scope.split(' ');
    if (!scopes.length || new Set(scopes).size !== scopes.length ||
        scopes.some((scope) => !MCP_SCOPES.some((known) => known === scope))) {throw new RemoteAuthenticationError();}
    return { issuer: config.issuer, subject: payload.sub, clientId: payload.client_id, grantId: payload.grant_id, scopes };
  } catch {
    throw new RemoteAuthenticationError();
  }
};

export const requiredToolScope = (body: unknown): string | undefined => {
  if (!body || typeof body !== 'object' || !('method' in body) || body.method !== 'tools/call' ||
      !('params' in body) || !body.params || typeof body.params !== 'object' || !('name' in body.params) ||
      typeof body.params.name !== 'string') {return undefined;}
  const name = body.params.name;
  if (name === 'balance') {return 'balance:read';}
  if (name === 'render_interior') {return 'render:interior';}
  if (name === 'render_exterior') {return 'render:exterior';}
  const scope = name.replaceAll('_', '-');
  return MCP_SCOPES.find((known) => known === scope);
};
