# MyArchitectAI MCP server

[![npm](https://img.shields.io/npm/v/@myarchitectai/mcp)](https://www.npmjs.com/package/@myarchitectai/mcp)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for the
[MyArchitectAI](https://www.myarchitectai.com) rendering API. It gives MCP-compatible assistants
(Claude Code, Claude Desktop, Cursor, …) tools to generate photorealistic architectural renders,
edit images, change textures and atmosphere, animate renders, generate prompts, transfer styles, create images from text, and upscale to 4K/8K — plus tools to preview, save, and track results.

## Features

**API tools** (charged in USD, except `balance`):

| Tool | What it does | Required | Optional |
| --- | --- | --- | --- |
| `render_exterior` | Photorealistic **exterior** render from a sketch, drawing, 3D screenshot, or photo | `image`, `outputFormat` | `prompt` |
| `render_interior` | Photorealistic **interior** render | `image`, `outputFormat` | `prompt` |
| `style_transfer` | Apply a reference image's style to a source image | `image`, `referenceImage`, `outputFormat` | `prompt`, `negativePrompt`, `styleTransferStrength` |
| `text_to_image` | Generate an architectural image from text | `prompt`, `outputFormat`, `outputWidth`, `outputHeight` | `negativePrompt` |
| `auto_prompt` | Describe an image as a render prompt (plain text) | `image` | — |
| `edit_by_prompt` | Apply an edit instruction | `image`, `prompt` | `referenceImage` |
| `change_textures` | Retexture masked surfaces | `image`, `mask`, exactly one of `prompt` / `referenceImage` | — |
| `set_atmosphere` | Change interior lighting or exterior atmosphere | `image`, `sceneType`; interior: `lighting`; exterior: at least one of `timeOfDay` / `season` / `weather` | Additional exterior controls |
| `animate` | Animate a frame or transition between frames (video URL) | `startFrameUrl`, `prompt` | `endFrameUrl` |
| `upscale` | Upscale to 4K or 8K | `image` | `targetResolution`, `outputFormat` |
| `upscale_4k` | Legacy 4K endpoint; prefer `upscale` | `image` | `outputFormat` |
| `balance` | Read the current account balance without a charge | — | — |

**Quality-of-life tools** (no API charge):

| Tool | What it does |
| --- | --- |
| `preview_image` | Fetch a URL and return the image **inline**, so the assistant (and GUI clients) can see it |
| `save_image` | Download an image URL to disk |
| `validate_image_url` | Check an input URL is a reachable image *before* a paid generation |
| `usage_summary` | Session totals: requests, USD spent, last-known balance |
| `list_recent_generations` | Recent image/video/text results, cost, balance and request IDs |

Image inputs accept a public HTTPS URL reachable by MyArchitectAI or an inline `data:image/<mime>;base64,<payload>` URI. Output formats are endpoint-specific: upscale accepts `jpg`/`webp`/`png`, but PNG is unavailable at 8K and AVIF is unsupported. Text-to-image dimensions are 128–2048px. Requests have a 10 MB body limit; prefer URLs for large inputs.

The API responds synchronously, streaming while it works. Animation typically takes 60–90 seconds; configure your MCP host's tool timeout to accommodate it. Image utilities do not preview or download videos; open the returned animation URL in a video-capable client.

The server exposes **17 tools**, covering all **12 API operations** in the [published API reference](https://portal.myarchitectai.com/docs). [API contract maintenance](docs/API-CONTRACT.md) describes the snapshot and automated drift checks.

## Install

You need a MyArchitectAI API key — create one in the [portal](https://portal.myarchitectai.com). It
is passed via the `MYARCHITECTAI_API_KEY` environment variable and sent as the `x-api-key` header.

### Claude Code

```bash
claude mcp add myarchitectai \
  --env MYARCHITECTAI_API_KEY=your-api-key \
  -- npx -y @myarchitectai/mcp
```

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "myarchitectai": {
      "command": "npx",
      "args": ["-y", "@myarchitectai/mcp"],
      "env": { "MYARCHITECTAI_API_KEY": "your-api-key" }
    }
  }
}
```

### Cursor, Windsurf, VS Code, and other MCP hosts

Use the same stdio launch — command `npx`, args `["-y", "@myarchitectai/mcp"]`, with
`MYARCHITECTAI_API_KEY` in `env` — in that host's MCP config. (Note: VS Code's config uses the key
`servers`, not `mcpServers`.)

### Claude Code plugin

For one-command setup with a bundled image-compare skill and a `/render` workflow, install the
companion plugin: **[myarchitectai-claude-plugin](https://github.com/MyArchitectAI/myarchitectai-claude-plugin)**.

```
/plugin marketplace add MyArchitectAI/myarchitectai-claude-plugin
/plugin install myarchitectai@myarchitectai
```

### Docker

A `Dockerfile` is included. Build and run the stdio server (keep stdin attached with `-i`; no port
is exposed):

```bash
docker build -t myarchitectai-mcp .
docker run -i -e MYARCHITECTAI_API_KEY=your-api-key myarchitectai-mcp
```

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `MYARCHITECTAI_API_KEY` | **yes** | — | Your API key (sent as `x-api-key`). |
| `MYARCHITECTAI_BASE_URL` | no | `https://api.myarchitectai.com/v1` | Override the API base URL. |
| `MYARCHITECTAI_TIMEOUT_MS` | no | `120000` | Total call timeout including retries, backoff and body in ms (1000–600000). |
| `MYARCHITECTAI_MAX_RETRIES` | no | `2` | Safe retries inside the total timeout, 0 disables (0–10). |
| `MYARCHITECTAI_DOWNLOAD_DIR` | no | `renders` | Directory `save_image` writes to. |
| `MYARCHITECTAI_MAX_PREVIEW_BYTES` | no | `5000000` | Max bytes `preview_image` embeds inline before falling back to a URL. |
| `MYARCHITECTAI_STATE_FILE` | no | — | Optional path to persist generation history across restarts. |

## Behavior

- **Success** → a text summary listing the generated image URL(s), cost, and balance, plus
  `structuredContent` of the shape `{ output: string[], balance: number, cost: number, requestId?: number }`. `auto_prompt` returns `output: string` containing text; `balance` returns only `{ balance }`. Amounts are USD. Request IDs are preserved for support.
- **API/validation errors** (bad input, invalid key, rate limits, server errors) are returned as
  tool results with `isError: true` and a clear message — the server does not crash.
- **Safe retries**: paid operations retry only HTTP 429 and 502 responses, which the API explicitly guarantees were not charged. Unknown outcomes (network errors, timeouts and other 5xx responses) are never automatically replayed. Read-only balance lookups can retry transient failures. Backoff, every attempt and response-body consumption share one `MYARCHITECTAI_TIMEOUT_MS` budget. Inspect the API request log before manually retrying an uncertain paid call.

API diagnostics are JSON lines on stderr; stdout remains the MCP protocol channel. Logs include endpoint, status, outcome, duration and request ID without prompts, media, keys or response bodies. No production analytics or error telemetry is sent.

## Keeping the API current

```bash
npm run build
npm run api:check        # registered tools against the reviewed snapshot
npm run api:check:live   # also compare with the current published OpenAPI
npm run api:update      # refresh snapshot; then align code and tests
```

CI checks the live contract on PRs, main pushes and manual dispatch. A spec change fails the check and requires review; runtime capabilities never change silently.

## Authentication

The server authenticates with an **API key** (`x-api-key`) — the only scheme the MyArchitectAI API
supports. It runs locally over stdio, so the key stays in your environment. There is no OAuth
provider on the API side; OAuth would only become relevant if this were hosted as a remote MCP
server, and even then the server would still call the API with a key. Credential handling is
isolated in `src/config.ts` and the client's header injection.

## Contributing

Contributions are welcome — please open an issue or PR. The published npm package is built from this
repository.

```bash
git clone https://github.com/MyArchitectAI/myarchitectai-api-mcp.git
cd myarchitectai-api-mcp
npm install
npm run build       # compile TypeScript to dist/
npm run typecheck   # strict type-check of src + tests
npm test            # unit + integration tests (node:test)
node scripts/smoke.mjs   # spawn the built server and list its tools over stdio
```

Run `npm run build && npm run typecheck && npm test` before submitting a PR.

To point an MCP host at your **local build** instead of the published package, use the command
`node` with args `["/absolute/path/to/dist/index.js"]`.

### Project layout

```
src/
  index.ts     entry point: load config, register tools, serve over stdio
  config.ts    env loading/validation + server identity
  client.ts    HTTP client: auth, timeout, retries, response/error mapping
  errors.ts    typed error hierarchy (retryable vs not)
  schemas.ts   Zod input/output schemas (mirror the API)
  tools.ts     tool registration + result/error formatting
  media.ts     image fetch/save/preview helpers (the QoL tools)
  session.ts   in-memory (optionally persisted) generation history
test/          node:test suites (config, client, media, session, end-to-end MCP)
docs/          DISTRIBUTION.md — per-host coverage & transport notes
```

### Releasing (maintainers)

Published as [`@myarchitectai/mcp`](https://www.npmjs.com/package/@myarchitectai/mcp) via npm
[Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers) — no token is stored. CI runs
build/typecheck/tests on every push and PR; pushing a `vX.Y.Z` tag triggers
`.github/workflows/release.yml`, which publishes with provenance.

```bash
npm version patch   # or minor / major — bumps package.json and creates the tag
git push --follow-tags
```

One-time setup: publish once manually (`npm publish --access public`) so the package exists, then
attach the GitHub Actions trusted publisher under the npm package's **Settings → Trusted Publisher**
(organization `MyArchitectAI`, repository `myarchitectai-api-mcp`, workflow `release.yml`).

## License

[MIT](./LICENSE) © MyArchitectAI
