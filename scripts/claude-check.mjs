import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const messages = new Map([
  ['authentication', 'Claude rejected the configured OAuth credential. Renew CLAUDE_CODE_OAUTH_TOKEN.'],
  ['quota', 'Claude reported a usage or rate limit. Check the account associated with CLAUDE_CODE_OAUTH_TOKEN.'],
  ['usage_limit', 'The Claude account has reached its subscription usage limit. Wait for its reset or configure a CI credential with available usage.'],
  ['rate_limit', 'Claude rejected the request with a rate limit. Retry after the provider permits requests.'],
  ['credit_balance', 'The Claude account has insufficient credits. Check the account attached to the CI credential.'],
  ['model', 'Claude rejected the configured model. Check account access and the exact model ID.'],
  ['network', 'Claude could not reach its service. Inspect runner connectivity.'],
  ['missing_credential', 'CLAUDE_CODE_OAUTH_TOKEN is missing.'],
  ['missing_result', 'Claude produced no execution result. Inspect the action setup or workflow validation error above.'],
  ['unknown', 'Claude failed without a recognized startup error. Raw model output is withheld from logs.'],
  ['success', 'Claude authentication and a tool-free response succeeded.'],
]);
const outcome = (category) => ({ category, message: messages.get(category) });

/** Return fixed classifications only: never print model messages or tool output. */
export const classify = (raw, exitCode = 1, stderr = '') => {
  let output;
  try { output = JSON.parse(raw); } catch {
    const category = failureCategory(`${raw}\n${stderr}`.toLowerCase(), 'missing_result');
    return outcome(category);
  }
  const items = Array.isArray(output) ? output : [output];
  const result = items.findLast((item) => item && item.type === 'result');
  if (!result) return outcome('missing_result');
  if (exitCode === 0 && result.is_error === false && result.subtype === 'success') {
    return outcome('success');
  }
  // Only the final error result is inspected; assistant/tool messages are excluded.
  const detail = JSON.stringify({ result: result.result, errors: result.errors }).toLowerCase();
  const category = failureCategory(detail);
  return outcome(category);
};

const failureCategory = (detail, fallback = 'unknown') => {
  let category = fallback;
  if (/401|authentication_error|invalid.*(?:token|credential)|oauth.*(?:expired|invalid)|not logged in|please run.*login/.test(detail)) category = 'authentication';
  else if (/429|rate.?limit/.test(detail)) category = 'rate_limit';
  else if (/credit balance/.test(detail)) category = 'credit_balance';
  else if (/usage.?limit|limit reached|hit.*limit/.test(detail)) category = 'usage_limit';
  else if (/quota/.test(detail)) category = 'quota';
  else if (/invalid model|model.*(?:not found|not available|not supported|does not exist)|not authorized.*model|not_found_error/.test(detail)) category = 'model';
  else if (/connection error|econn|enotfound|network error|fetch failed/.test(detail)) category = 'network';
  return category;
};

const emit = (result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.category !== 'success') process.exitCode = 1;
};

const runDiagnostic = () => {
  if (process.argv[2] !== 'probe') throw new Error('Use probe [claude executable]');
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    emit(outcome('missing_credential'));
    return;
  }
  const overrides = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !overrides.has(key)));
  const run = spawnSync(process.argv[3] || 'claude', ['-p', 'Reply only OK.', '--model', 'claude-sonnet-4-6', '--tools', '', '--max-turns', '1', '--output-format', 'json', '--no-session-persistence'], {
    cwd: mkdtempSync(join(tmpdir(), 'claude-ci-probe-')), env, encoding: 'utf8', timeout: 60_000, maxBuffer: 2_000_000,
  });
  emit(classify(run.stdout || '', run.status, run.stderr || ''));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runDiagnostic();
