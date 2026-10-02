import { pathToFileURL } from 'node:url';

const canonicalOrigin = 'https://mcp.myarchitectai.com';
const shaPattern = /^[0-9a-f]{40}$/;

const requireJson = async (response, label) => {
  if (response.status !== 200) {
    throw new Error(`${label}: expected HTTP 200, got ${response.status}`);
  }
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new Error(`${label}: expected JSON content type`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label}: invalid JSON`);
  }
};

export const verifyDeployment = async ({ origin = canonicalOrigin, revision, fetchImpl = fetch }) => {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.origin !== origin || base.pathname !== '/' || base.search || base.hash) {
    throw new Error('Origin must be an exact HTTPS origin');
  }
  if (!shaPattern.test(revision ?? '')) {
    throw new Error('Revision must be a lowercase 40-character Git SHA');
  }

  const request = (path, init = {}) => fetchImpl(new URL(path, base), {
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
    ...init,
  });

  const health = await requireJson(await request('/health'), '/health');
  if (health.status !== 'ok' || health.scope !== 'process' || health.revision !== revision) {
    throw new Error('/health: live revision or status differs from tested source');
  }

  const metadataUrl = new URL('/.well-known/oauth-protected-resource', base).href;
  const resource = new URL('/mcp', base).href;
  const metadata = await requireJson(await request('/.well-known/oauth-protected-resource'), 'protected-resource metadata');
  if (metadata.resource !== resource) {
    throw new Error('Protected-resource metadata: canonical resource mismatch');
  }
  if (!Array.isArray(metadata.authorization_servers) || metadata.authorization_servers.length === 0 ||
      metadata.authorization_servers.some((issuer) => {
        try {
          const url = new URL(issuer);
          return url.protocol !== 'https:' || Boolean(url.username || url.password || url.search || url.hash);
        } catch {
          return true;
        }
      })) {
    throw new Error('Protected-resource metadata: missing valid HTTPS authorization server');
  }

  const challenge = await request('/mcp', {
    method: 'POST',
    headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'deploy-verifier', version: '1.0.0' } },
    }),
  });
  if (challenge.status !== 401) {
    throw new Error(`/mcp: expected unauthenticated HTTP 401, got ${challenge.status}`);
  }
  const authenticate = challenge.headers.get('www-authenticate') ?? '';
  const advertised = /^Bearer\b/i.test(authenticate) && /(?:^|[,\s])resource_metadata="([^"]+)"/i.exec(authenticate)?.[1];
  if (advertised !== metadataUrl) {
    throw new Error('/mcp: bearer challenge did not advertise canonical protected-resource metadata');
  }

  return { origin, revision, resource, metadataUrl, issuerCount: metadata.authorization_servers.length };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const revision = process.argv[2];
  try {
    const result = await verifyDeployment({ revision });
    process.stdout.write(`LIVE_BOUNDARY_VERIFIED origin=${result.origin} revision=${result.revision} resource=${result.resource}\n`);
  } catch (error) {
    process.stderr.write(`LIVE_VERIFICATION_FAILED: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
  }
}
