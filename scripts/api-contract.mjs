// Read-only verification. This client never calls an API tool.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const source = 'https://portal.myarchitectai.com/openapi.json';
const snapshotUrl = new URL('../spec/openapi.json', import.meta.url);

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};

const validateDocument = (spec) => {
  assert.match(spec.openapi, /^3\.0\./);
  assert.equal(spec.servers?.[0]?.url, 'https://api.myarchitectai.com/v1');
  assert.ok(spec.paths && spec.components?.schemas, 'Missing API paths or schemas');
};

const resolve = (spec, schema) => {
  if (!schema?.$ref) return schema ?? { type: 'object', properties: {} };
  const prefix = '#/components/schemas/';
  assert.ok(schema.$ref.startsWith(prefix), `Unsupported reference: ${schema.$ref}`);
  const result = spec.components.schemas[schema.$ref.slice(prefix.length)];
  assert.ok(result, `Unresolved reference: ${schema.$ref}`);
  return result;
};

// MCP tool inputs are objects. Conditional requirements are enforced in Zod
// refinements and exercised in server.test.ts; compare their shared input surface.
const flatten = (spec, original) => {
  const schema = resolve(spec, original);
  if (!schema.oneOf) return schema;
  const branches = schema.oneOf.map((branch) => flatten(spec, branch));
  const properties = {};
  for (const branch of branches) {
    for (const [name, property] of Object.entries(branch.properties ?? {})) {
      if (properties[name]?.enum && property.enum) {
        properties[name] = { ...property, enum: [...new Set([...properties[name].enum, ...property.enum])] };
      } else {
        properties[name] = property;
      }
    }
  }
  return { type: 'object', properties,
    required: (branches[0].required ?? []).filter((name) => branches.every((branch) => branch.required?.includes(name))),
  };
};

const checkFields = (expected, actual, label) => {
  assert.deepEqual(Object.keys(actual.properties ?? {}).sort(), Object.keys(expected.properties ?? {}).sort(), `${label}: fields differ`);
  assert.deepEqual([...(actual.required ?? [])].sort(), [...(expected.required ?? [])].sort(), `${label}: required fields differ`);
  for (const [name, property] of Object.entries(expected.properties ?? {})) {
    const current = actual.properties[name];
    // Existing MCP guard requires whole-pixel dimensions; the API uses number.
    const type = label === 'text_to_image' && ['outputWidth', 'outputHeight'].includes(name) ? 'integer' : property.type;
    assert.equal(current.type, type, `${label}.${name}: type differs`);
    assert.deepEqual(current.enum?.slice().sort(), property.enum?.slice().sort(), `${label}.${name}: enum differs`);
    for (const bound of ['minimum', 'maximum', 'minLength', 'maxLength']) {
      if (property[bound] !== undefined) assert.equal(current[bound], property[bound], `${label}.${name}: ${bound} differs`);
    }
  }
};

const checkTools = async (spec) => {
  const { registerTools, API_TOOL_ENDPOINTS } = await import('../dist/tools.js');
  const { MyArchitectAIClient } = await import('../dist/client.js');
  const { SessionStore } = await import('../dist/session.js');
  const { MediaService } = await import('../dist/media.js');
  const config = { apiKey: 'contract-fixture', baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000,
    maxRetries: 0, downloadDir: 'renders', maxPreviewBytes: 1024, stateFile: undefined };
  const fetchImpl = async () => { throw new Error('Contract checks must not call the API'); };
  const server = new McpServer({ name: 'contract-check', version: '0.0.0' });
  registerTools(server, { config, client: new MyArchitectAIClient(config, fetchImpl), session: new SessionStore(),
    media: new MediaService({ timeoutMs: 1000, maxBytes: 1024, fetchImpl }) });
  const client = new Client({ name: 'contract-check', version: '0.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.keys(item).filter((method) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].includes(method)).map((method) => `${method.toUpperCase()} ${path}`));
    assert.deepEqual(Object.values(API_TOOL_ENDPOINTS).map((path) => `POST ${path}`).sort(), operations.sort(), 'API operation coverage differs');
    for (const [name, path] of Object.entries(API_TOOL_ENDPOINTS)) {
      const tool = tools.find((item) => item.name === name);
      assert.ok(tool, `Missing MCP tool: ${name}`);
      const operation = spec.paths[path].post;
      checkFields(flatten(spec, operation.requestBody?.content?.['application/json']?.schema), tool.inputSchema, name);
      const response = resolve(spec, operation.responses['200'].content['application/json'].schema);
      const success = response.oneOf ? resolve(spec, response.oneOf.find((item) => !item.$ref.endsWith('/ErrorResponse'))) : response;
      const normalized = structuredClone(success);
      // Preserve the existing array output contract and pre-requestId fixtures.
      if (name !== 'auto_prompt' && name !== 'balance') normalized.properties.output = { type: 'array' };
      normalized.required = normalized.required.filter((field) => field !== 'requestId');
      checkFields(normalized, tool.outputSchema, `${name} response`);
      assert.equal(tool.annotations?.readOnlyHint, name === 'balance', `${name}: read-only annotation differs`);
    }
    process.stdout.write(`API_CONTRACT_OK: ${operations.length} operations, ${tools.length} MCP tools\n`);
  } finally {
    await client.close();
    await server.close();
  }
};

try {
  const mode = process.argv[2];
  assert.ok(mode === undefined || mode === '--live' || mode === '--update', 'Usage: api-contract.mjs [--live|--update]');
  let snapshot = JSON.parse(await readFile(snapshotUrl, 'utf8'));
  validateDocument(snapshot);
  if (mode) {
    const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
    assert.equal(response.status, 200, `OpenAPI fetch failed: HTTP ${response.status}`);
    const live = await response.json();
    validateDocument(live);
    if (mode === '--update') {
      await writeFile(snapshotUrl, `${JSON.stringify(live, null, 2)}\n`);
      snapshot = live;
      process.stdout.write('Updated spec/openapi.json; align implementation and run api:check before release.\n');
    } else {
      assert.ok(JSON.stringify(canonical(snapshot)) === JSON.stringify(canonical(live)), 'Published API changed. Run npm run api:update, inspect the diff and align tools/tests.');
      process.stdout.write('LIVE_SPEC_OK\n');
    }
  }
  // Updating the source is independent of having a build; verification is explicit.
  if (mode !== '--update') await checkTools(snapshot);
} catch (err) {
  process.stderr.write(`API_CONTRACT_FAILED: ${err.message}\n`);
  process.exitCode = 1;
}
