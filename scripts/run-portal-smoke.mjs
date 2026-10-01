// Explicitly link the companion source for the optional two-checkout smoke test.
// No package is downloaded and no existing link/directory is overwritten.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.argv[2], 'Pass the API Portal checkout containing the companion bridge');
const checkout = realpathSync(process.argv[2]);
const metadata = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'));
assert.equal(metadata.name, 'MyArchitectAI-api-portal', 'Expected the API Portal companion checkout');
const fixture = fileURLToPath(new URL('../.portal-smoke', import.meta.url));
symlinkSync(checkout, fixture, 'dir');
try {
  const result = spawnSync(process.execPath, ['--import', 'tsx',
    fileURLToPath(new URL('./smoke-portal.mjs', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit', timeout: 60_000,
  });
  if (result.error) { throw result.error; }
  process.exitCode = result.status ?? 1;
} finally {
  unlinkSync(fixture);
}
