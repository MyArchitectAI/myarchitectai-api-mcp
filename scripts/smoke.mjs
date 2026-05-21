// Spawns the built server over stdio and verifies the MCP handshake + tool list.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  env: { ...process.env, MYARCHITECTAI_API_KEY: 'smoke-test-key' },
  stderr: 'inherit',
});

const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('\nTool count:', tools.length);
for (const t of tools) {
  const props = Object.keys(t.inputSchema?.properties ?? {});
  console.log(`- ${t.name}  required=[${(t.inputSchema?.required ?? []).join(',')}]  props=[${props.join(',')}]  outputSchema=${t.outputSchema ? 'yes' : 'no'}`);
}

await client.close();
console.log('\nSMOKE_OK');
