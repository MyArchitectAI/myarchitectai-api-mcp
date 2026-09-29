import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseHostedConfig } from '../src/hosted-config.js';
import { hostedEnv } from './fixtures/hosted-env.js';

describe('hosted runtime configuration', () => {
  it('derives the exact portal issuer and JWKS, with fixed shared-history scope', () => {
    const config = parseHostedConfig(hostedEnv());
    assert.equal(config.auth.issuer, 'https://portal-project.supabase.co/auth/v1');
    assert.equal(config.auth.jwksUrl, 'https://portal-project.supabase.co/auth/v1/.well-known/jwks.json');
    assert.equal(config.auth.canonicalResource, 'https://mcp.myarchitectai.com/mcp');
    assert.equal(config.auth.deploymentRevision, '0123456789abcdef0123456789abcdef01234567');
    assert.equal(config.history.namespace, 'myarchitectai:mcp:production');
    assert.equal(config.history.ttlSeconds, 1800);
    assert.equal(config.history.maxRecordsPerUser, 100);
    assert.equal(config.portal.keyBindings.get('00000000-0000-0000-0000-000000000001'), 101);
  });

  it('fails closed on missing billing choice, deployment revision and credentials', () => {
    for (const name of ['MCP_BILLING_MODE', 'MCP_DEPLOYMENT_REVISION',
      'PORTAL_SUPABASE_SERVICE_ROLE_KEY', 'AWS_SECRET_ACCESS_KEY', 'UPSTASH_REDIS_REST_TOKEN']) {
      const env = hostedEnv();
      delete env[name];
      assert.throws(() => parseHostedConfig(env));
    }
    assert.throws(() => parseHostedConfig({ ...hostedEnv(), MCP_BILLING_MODE: 'subscription' }));
  });

  it('rejects unsafe issuer origins, bindings, allowlists and revisions without echoing secrets', () => {
    const invalid: NodeJS.ProcessEnv[] = [
      { ...hostedEnv(), PORTAL_SUPABASE_URL: 'https://other.example/rest/v1' },
      { ...hostedEnv(), PORTAL_SUPABASE_URL: 'http://portal-project.supabase.co' },
      { ...hostedEnv(), MCP_PORTAL_KEY_BINDINGS: '{"not-a-user":101}' },
      { ...hostedEnv(), MCP_PORTAL_KEY_BINDINGS: '{"00000000-0000-0000-0000-000000000001":0}' },
      { ...hostedEnv(), MCP_OAUTH_CLIENT_IDS: '["trusted-client","trusted-client"]' },
      { ...hostedEnv(), MCP_DEPLOYMENT_REVISION: 'short' },
      { ...hostedEnv(), AWS_REGION: 'eu-central-1.evil.example' },
    ];
    for (const env of invalid) {
      assert.throws(() => parseHostedConfig(env), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes('synthetic-service-key'));
        assert.ok(!error.message.includes('synthetic-secret-access-key'));
        return true;
      });
    }
  });
});
