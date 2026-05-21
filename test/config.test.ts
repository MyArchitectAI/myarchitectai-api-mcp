import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_BASE_URL, loadConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

describe('loadConfig', () => {
  it('throws ConfigError when the API key is missing', () => {
    assert.throws(() => loadConfig({}), ConfigError);
  });

  it('throws ConfigError when the API key is blank', () => {
    assert.throws(() => loadConfig({ MYARCHITECTAI_API_KEY: '   ' }), ConfigError);
  });

  it('returns sane defaults with a valid key', () => {
    const config = loadConfig({ MYARCHITECTAI_API_KEY: 'k' });
    assert.equal(config.apiKey, 'k');
    assert.equal(config.baseUrl, DEFAULT_BASE_URL);
    assert.equal(config.timeoutMs, 120_000);
    assert.equal(config.maxRetries, 2);
  });

  it('trims surrounding whitespace from the key', () => {
    assert.equal(loadConfig({ MYARCHITECTAI_API_KEY: '  k  ' }).apiKey, 'k');
  });

  it('strips trailing slashes from the base URL', () => {
    const config = loadConfig({
      MYARCHITECTAI_API_KEY: 'k',
      MYARCHITECTAI_BASE_URL: 'https://api.example.com/v1///',
    });
    assert.equal(config.baseUrl, 'https://api.example.com/v1');
  });

  it('rejects a malformed base URL', () => {
    assert.throws(
      () => loadConfig({ MYARCHITECTAI_API_KEY: 'k', MYARCHITECTAI_BASE_URL: 'not a url' }),
      ConfigError,
    );
  });

  it('rejects a non-http(s) base URL', () => {
    assert.throws(
      () => loadConfig({ MYARCHITECTAI_API_KEY: 'k', MYARCHITECTAI_BASE_URL: 'ftp://example.com' }),
      ConfigError,
    );
  });

  it('parses valid numeric overrides', () => {
    const config = loadConfig({
      MYARCHITECTAI_API_KEY: 'k',
      MYARCHITECTAI_TIMEOUT_MS: '5000',
      MYARCHITECTAI_MAX_RETRIES: '0',
    });
    assert.equal(config.timeoutMs, 5000);
    assert.equal(config.maxRetries, 0);
  });

  it('rejects out-of-range or non-integer overrides', () => {
    const key = { MYARCHITECTAI_API_KEY: 'k' };
    assert.throws(() => loadConfig({ ...key, MYARCHITECTAI_TIMEOUT_MS: '0' }), ConfigError);
    assert.throws(() => loadConfig({ ...key, MYARCHITECTAI_TIMEOUT_MS: 'abc' }), ConfigError);
    assert.throws(() => loadConfig({ ...key, MYARCHITECTAI_MAX_RETRIES: '-1' }), ConfigError);
    assert.throws(() => loadConfig({ ...key, MYARCHITECTAI_MAX_RETRIES: '99' }), ConfigError);
  });
});
