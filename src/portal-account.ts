import { MyArchitectAIClient } from './client.js';
import { createPortalRequest, type PortalDependencies, type PortalOptions } from './portal-transport.js';
import type { ResolveAccount } from './remote.js';

export type PortalAccountOptions = PortalOptions;
export type PortalAccountDependencies = PortalDependencies;

/** Portal retains ownership checks, AWS credentials, API keys and billing. */
export const createPortalAccountResolver = (
  options: PortalAccountOptions,
  dependencies: PortalAccountDependencies = {},
): ResolveAccount => {
  const request = createPortalRequest(options, dependencies);
  return async (identity, { signal }) => {
    if (identity.issuer !== options.issuer || signal.aborted) { return undefined; }
    const response = await request('account', {}, identity, signal);
    if (response.status === 403) { return undefined; }
    if (!response.ok) { throw new Error('Portal account lookup unavailable'); }
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('authorized' in body) || body.authorized !== true) {
      throw new Error('Invalid Portal account response');
    }
    return {
      client: new MyArchitectAIClient({
        baseUrl: `${new URL(options.baseUrl).origin}/api/mcp`, timeoutMs: 120_000, maxRetries: 2,
        transport: (path, input, signal) => request('execute',
          { path, ...(input === undefined ? {} : { body: input }) }, identity, signal),
      }),
      config: { downloadDir: 'renders', maxPreviewBytes: 1_000_000, timeoutMs: 120_000 },
    };
  };
};

export const createPortalHealthProbe = (options: PortalOptions, dependencies: PortalDependencies = {}):
  ((signal: AbortSignal) => Promise<boolean>) => {
  const request = createPortalRequest(options, dependencies);
  return async (signal) => {
    const response = await request('health', {}, undefined, signal);
    if (!response.ok) { return false; }
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null && 'status' in body && body.status === 'ok';
  };
};
