import { ConfigError } from './errors.js';

export type RemoteHttpConfig = {
  canonicalResource: string;
  issuer: string;
  jwksUrl?: string | URL;
  allowedOAuthClientIds: readonly string[];
  allowedHosts?: readonly string[];
  allowedOrigins?: readonly string[];
  maxBodyBytes?: number;
  requestTimeoutMs?: number;
  maxConcurrentRequests?: number;
  healthToken?: string;
  deploymentRevision?: string;
};

export type ValidatedRemoteHttpConfig = {
  canonicalResource: string;
  issuer: string;
  jwksUrl?: URL;
  allowedOAuthClientIds: ReadonlySet<string>;
  allowedHosts: ReadonlySet<string>;
  allowedOrigins: ReadonlySet<string>;
  mcpPath: string;
  metadataUrl: string;
  metadataPath: string;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  maxConcurrentRequests: number;
  healthToken?: string;
  deploymentRevision?: string;
};

const positiveInteger = (value: number | undefined, fallback: number, name: string): number => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new ConfigError(`${name} must be a positive integer`);
  }
  return result;
};

const httpsUrl = (raw: string | URL, name: string): URL => {
  let url: URL;
  try {
    url = new URL(String(raw));
  } catch {
    throw new ConfigError(`${name} must be a valid HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new ConfigError(`${name} must be a public HTTPS URL without credentials, query or fragment`);
  }
  return url;
};

export const validateRemoteHttpConfig = (input: RemoteHttpConfig): ValidatedRemoteHttpConfig => {
  const resource = httpsUrl(input.canonicalResource, 'canonicalResource');
  const issuer = httpsUrl(input.issuer, 'issuer');
  if (resource.pathname === '/' || resource.pathname.endsWith('/') || resource.href !== input.canonicalResource) {
    throw new ConfigError('canonicalResource must be the exact MCP endpoint URL without a trailing slash');
  }
  if (issuer.href.replace(/\/$/, '') !== input.issuer) {
    throw new ConfigError('issuer must not end with a trailing slash');
  }
  const allowedOAuthClientIds = new Set(input.allowedOAuthClientIds);
  if (allowedOAuthClientIds.size === 0 || [...allowedOAuthClientIds].some((id) => !id || id.trim() !== id)) {
    throw new ConfigError('allowedOAuthClientIds must contain nonempty exact OAuth client IDs');
  }
  const allowedHosts = new Set([resource.hostname.toLowerCase()]);
  for (const host of input.allowedHosts ?? []) {
    if (!/^[a-z0-9.-]+$/i.test(host) || host.includes('..')) {
      throw new ConfigError('allowedHosts must contain hostnames without ports or schemes');
    }
    allowedHosts.add(host.toLowerCase());
  }
  const allowedOrigins = new Set<string>();
  for (const raw of input.allowedOrigins ?? []) {
    let origin: URL;
    try {
      origin = new URL(raw);
    } catch {
      throw new ConfigError('allowedOrigins must contain exact HTTP or HTTPS origins');
    }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== raw || origin.username || origin.password) {
      throw new ConfigError('allowedOrigins must contain exact HTTP or HTTPS origins');
    }
    allowedOrigins.add(raw);
  }
  const jwksUrl = input.jwksUrl === undefined ? undefined : httpsUrl(input.jwksUrl, 'jwksUrl');
  if (input.healthToken !== undefined && (!input.healthToken.trim() || input.healthToken !== input.healthToken.trim())) {
    throw new ConfigError('healthToken must be a nonempty exact token when configured');
  }
  if (input.deploymentRevision !== undefined && !/^[0-9a-f]{40}$/.test(input.deploymentRevision)) {
    throw new ConfigError('deploymentRevision must be an exact lowercase 40-character Git SHA');
  }
  const metadataPath = `/.well-known/oauth-protected-resource${resource.pathname}`;
  return {
    canonicalResource: resource.href,
    issuer: input.issuer,
    ...(jwksUrl ? { jwksUrl } : {}),
    allowedOAuthClientIds,
    allowedHosts,
    allowedOrigins,
    mcpPath: resource.pathname,
    metadataUrl: new URL('/.well-known/oauth-protected-resource', resource).href,
    metadataPath,
    maxBodyBytes: positiveInteger(input.maxBodyBytes, 1_000_000, 'maxBodyBytes'),
    requestTimeoutMs: positiveInteger(input.requestTimeoutMs, 180_000, 'requestTimeoutMs'),
    maxConcurrentRequests: positiveInteger(input.maxConcurrentRequests, 32, 'maxConcurrentRequests'),
    ...(input.healthToken === undefined ? {} : { healthToken: input.healthToken }),
    ...(input.deploymentRevision === undefined ? {} : { deploymentRevision: input.deploymentRevision }),
  };
};
