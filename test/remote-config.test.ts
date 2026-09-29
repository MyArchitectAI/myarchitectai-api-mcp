import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateRemoteHttpConfig, type RemoteHttpConfig } from '../src/remote-config.js';

const base: RemoteHttpConfig = {
  canonicalResource: 'https://mcp.example.com/mcp',
  issuer: 'https://auth.example.com/auth/v1',
  jwksUrl: 'https://auth.example.com/auth/v1/.well-known/jwks.json',
  allowedOAuthClientIds: ['trusted-client'],
};

describe('remote configuration', () => {
  it('derives stable path-aware metadata from the canonical MCP resource', () => {
    const config = validateRemoteHttpConfig(base);
    assert.equal(config.mcpPath, '/mcp');
    assert.equal(config.metadataPath, '/.well-known/oauth-protected-resource/mcp');
    assert.equal(config.metadataUrl, 'https://mcp.example.com/.well-known/oauth-protected-resource');
    assert.deepEqual([...config.allowedHosts], ['mcp.example.com']);
    assert.equal(config.deploymentRevision, undefined);
    const revision = '0123456789abcdef0123456789abcdef01234567';
    assert.equal(validateRemoteHttpConfig({ ...base, deploymentRevision: revision }).deploymentRevision, revision);
  });

  it('rejects unsafe resource, origin, client and capacity configurations', () => {
    const invalid: RemoteHttpConfig[] = [
      { ...base, canonicalResource: 'http://mcp.example.com/mcp' },
      { ...base, canonicalResource: 'https://mcp.example.com/mcp?token=secret' },
      { ...base, issuer: 'http://auth.example.com' },
      { ...base, allowedOAuthClientIds: [] },
      { ...base, allowedOAuthClientIds: [''] },
      { ...base, allowedOrigins: ['*'] },
      { ...base, allowedOrigins: ['https://trusted.example/path'] },
      { ...base, allowedHosts: ['host.example:443'] },
      { ...base, maxBodyBytes: 0 },
      { ...base, maxConcurrentRequests: 0 },
      { ...base, healthToken: '' },
      { ...base, deploymentRevision: '' },
      { ...base, deploymentRevision: '0123456789abcdef0123456789abcdef0123456' },
      { ...base, deploymentRevision: '0123456789abcdef0123456789abcdef0123456G' },
      { ...base, deploymentRevision: '0123456789ABCDEF0123456789abcdef01234567' },
    ];
    for (const candidate of invalid) {
      assert.throws(() => validateRemoteHttpConfig(candidate));
    }
  });
});
