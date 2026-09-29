import { waitUntil } from '@vercel/functions';
import { createHostedServer } from './hosted-config.js';
import { logEvent } from './logger.js';

try {
  const server = createHostedServer(process.env, { registerWork: waitUntil });
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error('Invalid hosted port');
  }
  server.listen(port);
} catch {
  logEvent({ event: 'hosted_startup_failure', outcome: 'error', fingerprint: 'remote.config' });
  throw new Error('Hosted MCP configuration unavailable');
}
