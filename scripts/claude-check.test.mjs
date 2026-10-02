import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from './claude-check.mjs';

test('reports startup failures without echoing provider messages or credentials', () => {
  for (const [detail, expected] of [
    ['API Error: 401 authentication_error OAuth token expired secret-fixture', 'authentication'],
    ['API Error: 429 rate_limit_error secret-fixture', 'rate_limit'],
    ['API Error: 429 rate_limit_error: rate limit reached secret-fixture', 'rate_limit'],
    ["You've hit your limit secret-fixture", 'usage_limit'],
    ['Credit balance is too low secret-fixture', 'credit_balance'],
    ['API Error: model not found secret-fixture', 'model'],
    ['system: Invalid model name secret-fixture', 'model'],
    ['Connection error secret-fixture', 'network'],
    ['Unrecognized error secret-fixture', 'unknown'],
  ]) {
    const result = classify(JSON.stringify([{ type: 'result', subtype: 'success', is_error: true, result: detail }]));
    assert.equal(result.category, expected);
    assert.equal(JSON.stringify(result).includes('secret-fixture'), false);
  }
});

test('does not treat a success subtype or absent output as a successful check', () => {
  assert.equal(classify(JSON.stringify({ type: 'result', subtype: 'success', is_error: true }), 0).category, 'unknown');
  assert.equal(classify('', 0).category, 'missing_result');
  assert.equal(classify(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }), 0).category, 'success');
});

test('ignores tool output when classifying the final failure', () => {
  const result = classify(JSON.stringify([
    { type: 'assistant', content: '401 authentication_error secret-fixture' },
    { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['unknown failure'] },
  ]));
  assert.equal(result.category, 'unknown');
  assert.equal(JSON.stringify(result).includes('secret-fixture'), false);
});

test('classifies startup stderr safely when Claude exits before writing JSON', () => {
  const result = classify('', 1, 'API Error: 401 authentication_error secret-fixture');
  assert.equal(result.category, 'authentication');
  assert.equal(JSON.stringify(result).includes('secret-fixture'), false);
});
