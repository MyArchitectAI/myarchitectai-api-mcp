# MyArchitectAI MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that exposes the
[MyArchitectAI](https://www.myarchitectai.com) rendering API to MCP-compatible clients such as
Claude Desktop, Claude Code, and Cursor. Generate photorealistic architectural renders, transfer
styles, create images from text, and upscale to 4K — all as tools your assistant can call.

> **Note:** the npm package name (`myarchitectai-mcp`) is a placeholder. Pick the final
> name/scope before publishing — see [Publishing](#publishing).

## Features

| Tool | What it does | Required inputs | Optional inputs |
| --- | --- | --- | --- |
| `render_exterior` | Photorealistic **exterior** render from a sketch/drawing/3D/photo | `image`, `outputFormat` | `prompt` |
| `render_interior` | Photorealistic **interior** render from a sketch/drawing/3D/photo | `image`, `outputFormat` | `prompt` |
| `style_transfer` | Apply the look of a reference image onto a source image | `image`, `referenceImage`, `outputFormat` | `prompt`, `negativePrompt`, `styleTransferStrength` (0–1) |
| `text_to_image` | Generate an architectural image from text only | `prompt`, `outputFormat`, `outputWidth`, `outputHeight` | `negativePrompt` |
| `upscale_4k` | Upscale an image up to 4K/8K | `image` | `outputFormat` |

Every tool returns the generated image URL(s) plus the credit `cost` and remaining `balance`,
both as a human-readable summary and as machine-readable `structuredContent`.

- `image` / `referenceImage` must be **publicly reachable URLs** (the API fetches them).
- `outputFormat` is one of `webp`, `jpg`, `png`, `avif` (text-to-image supports `png`/`jpg`/`webp` only).
- `outputWidth` / `outputHeight` range from `128` to `2048` pixels.
- Generation is synchronous and typically completes in under ~10 seconds.

### Quality-of-life tools (no credits consumed)

| Tool | What it does |
| --- | --- |
| `preview_image` | Fetch an image URL and return it **inline** so the agent (and GUI clients) can see it; optionally opens it in a browser when a display is available. |
| `save_image` | Download an image URL to disk (`MYARCHITECTAI_DOWNLOAD_DIR`, default `./renders`) — output URLs are public but may expire. |
| `validate_image_url` | HEAD-check that an input URL is a reachable image *before* spending a credit on a doomed render. |
| `usage_summary` | This session's totals: generations, credits spent, last-known balance (no paid call), and a per-tool breakdown. |
| `list_recent_generations` | Recent generations (tool, URLs, cost, balance) so you can re-preview or save an earlier result without regenerating. |

## Requirements

- Node.js **18+** (uses the built-in `fetch`).
- A MyArchitectAI API key.

## Getting an API key

Sign in at the [MyArchitectAI portal](https://portal.myarchitectai.com) and create an API key.
The free tier includes a limited number of requests per month. The key is sent on every request
as the `x-api-key` header.

## Installation

### From source (current)

```bash
git clone <your-repo-url> myarchitectai-mcp
cd myarchitectai-mcp
npm install
npm run build
```

The runnable server is then at `dist/index.js`.

### Via npx (after publishing to npm)

```bash
npx -y myarchitectai-mcp
```

## Configuration

Configuration is read from environment variables:

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `MYARCHITECTAI_API_KEY` | **yes** | — | Your API key, sent as the `x-api-key` header. |
| `MYARCHITECTAI_BASE_URL` | no | `https://api.myarchitectai.com/v1` | Override the API base URL. |
| `MYARCHITECTAI_TIMEOUT_MS` | no | `120000` | Per-request timeout in ms (1000–600000). |
| `MYARCHITECTAI_MAX_RETRIES` | no | `2` | Retries for transient failures, 0 disables (0–10). |
| `MYARCHITECTAI_DOWNLOAD_DIR` | no | `renders` | Directory `save_image` writes to. |
| `MYARCHITECTAI_MAX_PREVIEW_BYTES` | no | `5000000` | Max bytes `preview_image` embeds inline before falling back to a URL. |
| `MYARCHITECTAI_STATE_FILE` | no | — | Optional path to persist generation history across restarts. |

See [`.env.example`](./.env.example).

## Usage

### Claude Desktop

Add to your `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "myarchitectai": {
      "command": "node",
      "args": ["/absolute/path/to/myarchitectai-mcp/dist/index.js"],
      "env": { "MYARCHITECTAI_API_KEY": "your-api-key" }
    }
  }
}
```

After publishing to npm you can instead use:

```json
{
  "mcpServers": {
    "myarchitectai": {
      "command": "npx",
      "args": ["-y", "myarchitectai-mcp"],
      "env": { "MYARCHITECTAI_API_KEY": "your-api-key" }
    }
  }
}
```

### Claude Code

```bash
# From source:
claude mcp add myarchitectai \
  --env MYARCHITECTAI_API_KEY=your-api-key \
  -- node /absolute/path/to/myarchitectai-mcp/dist/index.js

# After publishing:
claude mcp add myarchitectai \
  --env MYARCHITECTAI_API_KEY=your-api-key \
  -- npx -y myarchitectai-mcp
```

### Any MCP client

The server communicates over **stdio**. Launch `node dist/index.js` with `MYARCHITECTAI_API_KEY`
set in the environment and speak MCP over stdin/stdout. Diagnostics are written to stderr only.

### As a Claude Code plugin

A companion **Claude Code plugin** lives in its own repo,
[`my-architect-ai-plugin`](../my-architect-ai-plugin). It bundles this server (launched via `npx`)
plus a `compare-renders` skill and a `/render` command, and collects the API key via `userConfig`
(stored in the OS keychain). See that repo's README to install it.

## Output and error behavior

- **Success** → a text summary listing the generated image URL(s), cost, and balance, plus
  `structuredContent` of the shape `{ output: string[], balance: number, cost: number }`.
- **API/validation errors** (bad input, invalid key, rate limits, server errors) are returned as a
  tool result with `isError: true` and a descriptive message — they do **not** crash the server.
- **Transient failures** (HTTP 408/425/429/5xx, network errors, timeouts) are retried automatically
  with exponential backoff and jitter, honoring `Retry-After`. Client errors (400/401/403) are not
  retried.

## Authentication (and a note on OAuth)

This server authenticates to MyArchitectAI with an **API key** because that is the only scheme the
MyArchitectAI API supports (`x-api-key` header; see their OpenAPI spec). There is no OAuth
authorization server on the MyArchitectAI side today.

Two distinct things people mean by "OAuth" here:

1. **OAuth into MyArchitectAI** (end users log in with a MyArchitectAI account). This would require
   MyArchitectAI to provide an OAuth 2.x authorization server (authorize/token endpoints, scopes,
   client registration). It does not exist yet, so it requires their cooperation.
2. **OAuth at the MCP layer.** The MCP spec defines OAuth 2.1 only for **remote/HTTP** servers. This
   is a **local stdio** server launched as a subprocess, so there is no network boundary to protect
   and the standard pattern is an environment-variable API key (what we do here).

If this is ever hosted as a remote, multi-tenant MCP server, you would add MCP OAuth 2.1 for the
client → server hop, but the server would **still** call MyArchitectAI with an API key (one shared
key, or per-user keys you store). All credential handling lives in `src/config.ts` and the client's
header injection, so introducing a token/credential provider later is a localized change.

## Development

```bash
npm run dev        # run from source with watch (tsx)
npm run build      # compile TypeScript to dist/
npm run typecheck  # strict type-check of src + tests (no emit)
npm test           # run the unit + integration test suite
node scripts/smoke.mjs   # spawn the built server and list its tools over stdio
```

### Project structure

```
src/
  index.ts     # entry point: load config, register tools, serve over stdio
  config.ts    # env loading/validation + server identity constants
  client.ts    # HTTP client: auth, timeout, retries, response/error mapping
  errors.ts    # typed error hierarchy (retryable vs not)
  schemas.ts   # Zod input/output schemas per tool (mirror the OpenAPI spec)
  tools.ts     # tool registration + result/error formatting
test/          # node:test suites (config, client, end-to-end MCP)
.github/workflows/   # CI (build/typecheck/test) and tag-triggered npm release
```

## Publishing

CI runs build, typecheck, and tests on every push/PR (`.github/workflows/ci.yml`). Pushing a
version tag (`vX.Y.Z`) triggers `.github/workflows/release.yml`, which publishes to npm with
[provenance](https://docs.npmjs.com/generating-provenance-statements).

**Before the first publish:**

1. Set the final `name` (and scope) in `package.json`.
2. Update `repository`, `bugs`, and `homepage` to the real GitHub URLs (required for provenance).
3. Add an `NPM_TOKEN` repository secret (an npm automation/granular token), **or** configure npm
   [Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers) and remove the token.
4. Tag and push:

   ```bash
   npm version patch   # or minor / major
   git push --follow-tags
   ```

### Docker

```bash
docker build -t myarchitectai-mcp .
docker run -i -e MYARCHITECTAI_API_KEY=your-api-key myarchitectai-mcp
```

The image runs the stdio server, so keep stdin attached (`-i`); no port is exposed.

## License

[MIT](./LICENSE)
