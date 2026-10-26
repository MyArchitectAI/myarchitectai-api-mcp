import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { describe, it } from 'node:test';
import { SignJWT } from 'jose';
import { createMcpOAuthAuthenticator, mcpAccessSigningKey, requiredToolScope, MCP_SCOPES } from '../src/mcp-oauth.js';

const config = { issuer: 'https://portal.example', canonicalResource: 'https://mcp.example/mcp', signingSecret: 'synthetic-shared-bridge-secret-1234567890' };
const subject = randomUUID();
const client = randomUUID();
const grant = randomUUID();
const token = (claims: Record<string, unknown> = {}, typ = 'mcp-access+jwt', key = mcpAccessSigningKey(config.signingSecret)): Promise<string> => {
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: config.issuer, aud: config.canonicalResource, sub: subject, client_id: client,
    grant_id: grant, scope: 'balance:read', iat, exp: iat + 900, jti: randomUUID(), ...claims })
    .setProtectedHeader({ alg: 'HS256', typ }).sign(key);
};
const request = (bearer: string, duplicate = false): IncomingMessage => ({
  headers: { authorization: `Bearer ${bearer}` },
  rawHeaders: ['Authorization', `Bearer ${bearer}`, ...(duplicate ? ['Authorization', `Bearer ${bearer}`] : [])],
} as IncomingMessage);

describe('MCP resource authorization', () => {
  it('verifies the exact issuer, resource, client, grant and consented scopes', async () => {
    assert.deepEqual(await createMcpOAuthAuthenticator(config)(request(await token())), {
      issuer: config.issuer, subject, clientId: client, grantId: grant, scopes: ['balance:read'],
    });
  });
  for (const [name, claims] of Object.entries({
    'browser audience': { aud: 'authenticated' },
    'alternate audience': { aud: [config.canonicalResource, 'authenticated'] },
    'Supabase issuer': { iss: 'https://project.supabase.co/auth/v1' },
    'Supabase session': { session_id: randomUUID() },
    'missing grant': { grant_id: undefined },
    'invalid subject': { sub: 'not-a-user' },
    'missing client': { client_id: undefined },
    'empty scope': { scope: '' },
    'unknown scope': { scope: 'password:write' },
    'duplicated scope': { scope: 'balance:read balance:read' },
    'missing expiry': { exp: undefined },
    'expired token': { iat: 100, exp: 900 },
    'extended lifetime': { exp: Math.floor(Date.now() / 1000) + 901 },
  })) {
    it(`rejects ${name}`, async () => {
      await assert.rejects(createMcpOAuthAuthenticator(config)(request(await token(claims))));
    });
  }
  it('rejects native signing keys, internal assertions and duplicate bearer headers', async () => {
    const authenticate = createMcpOAuthAuthenticator(config);
    await assert.rejects(authenticate(request(await token({}, 'mcp-access+jwt', Buffer.from(config.signingSecret)))));
    await assert.rejects(authenticate(request(await token({}, 'mcp-portal+jwt'))));
    await assert.rejects(authenticate(request(await token(), true)));
  });
  it('maps every hosted operation to its API-key permission for step-up challenges', () => {
    const tools = ['render_interior', 'render_exterior', 'text_to_image', 'edit_by_prompt', 'change_textures',
      'set_atmosphere', 'style_transfer', 'upscale', 'upscale_4k', 'animate', 'auto_prompt', 'balance'];
    assert.deepEqual(tools.map((name) => requiredToolScope({ method: 'tools/call', params: { name } })), [...MCP_SCOPES]);
    assert.equal(requiredToolScope({ method: 'tools/list' }), undefined);
  });
});
