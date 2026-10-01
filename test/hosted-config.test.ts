import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseHostedConfig } from '../src/hosted-config.js';
import { hostedEnv } from './fixtures/hosted-env.js';

describe('hosted runtime configuration', () => {
  it('derives the exact portal issuer and JWKS without a history dependency', () => {
    const config = parseHostedConfig(hostedEnv());
    assert.equal(config.auth.issuer, 'https://portal-project.supabase.co/auth/v1');
    assert.equal(config.auth.jwksUrl, 'https://portal-project.supabase.co/auth/v1/.well-known/jwks.json');
    assert.equal(config.auth.canonicalResource, 'https://mcp.myarchitectai.com/mcp');
    assert.equal(config.auth.deploymentRevision, '0123456789abcdef0123456789abcdef01234567');
    assert.deepEqual(Object.keys(config).sort(), ['auth', 'portal']);
    assert.equal(config.portal.baseUrl, 'https://portal.example');
    assert.equal('serviceRoleKey' in config.portal, false);
    assert.equal('awsAccessKeyId' in config.portal, false);
  });

  it('fails closed on missing billing choice, deployment revision and credentials', () => {
    for (const name of ['MCP_BILLING_MODE', 'MCP_DEPLOYMENT_REVISION',
      'PORTAL_BASE_URL', 'MCP_PORTAL_SIGNING_SECRET']) {
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
      { ...hostedEnv(), MCP_ALLOWED_HOSTS: '["trusted.example","trusted.example"]' },
      { ...hostedEnv(), MCP_DEPLOYMENT_REVISION: 'short' },
      { ...hostedEnv(), PORTAL_BASE_URL: 'https://portal.example/forward' },
      { ...hostedEnv(), MCP_PORTAL_SIGNING_SECRET: 'short' },
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
