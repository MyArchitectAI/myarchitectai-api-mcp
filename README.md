# MyArchitectAI MCP server

[![npm](https://img.shields.io/npm/v/@myarchitectai/mcp)](https://www.npmjs.com/package/@myarchitectai/mcp)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for the
[MyArchitectAI](https://www.myarchitectai.com) rendering API. It gives MCP-compatible assistants
(Claude Code, Claude Desktop, Cursor, …) tools to generate photorealistic architectural renders,
transfer styles, create images from text, and upscale to 4K — plus quality-of-life tools to preview,
save, and track results.

## Features

**Generation tools** (consume credits):

| Tool | What it does | Required | Optional |
| --- | --- | --- | --- |
| `render_exterior` | Photorealistic **exterior** render from a sketch, drawing, 3D screenshot, or photo | `image`, `outputFormat` | `prompt` |
| `render_interior` | Photorealistic **interior** render | `image`, `outputFormat` | `prompt` |
| `style_transfer` | Apply a reference image's style to a source image | `image`, `referenceImage`, `outputFormat` | `prompt`, `negativePrompt`, `styleTransferStrength` |
| `text_to_image` | Generate an architectural image from text | `prompt`, `outputFormat`, `outputWidth`, `outputHeight` | `negativePrompt` |
| `upscale_4k` | Upscale an image up to 4K/8K | `image` | `outputFormat` |

**Quality-of-life tools** (no credits consumed):

| Tool | What it does |
| --- | --- |
| `preview_image` | Fetch a URL and return the image **inline**, so the assistant (and GUI clients) can see it |
| `save_image` | Download an image URL to disk |
| `validate_image_url` | Check an input URL is a reachable image *before* spending a credit |
| `usage_summary` | Session totals: generations, credits spent, last-known balance |
| `list_recent_generations` | Recent results (URLs, cost, balance) to reuse without regenerating |

Image inputs accept either a **public HTTPS URL** reachable by MyArchitectAI, or an inline
**`data:image/<mime>;base64,<payload>`** URI for local files. `outputFormat` is one of
`webp`/`jpg`/`png`/`avif` (text-to-image: `png`/`jpg`/`webp`). Dimensions range 128–2048px.
Generation is synchronous (typically under ~10s) and returns the image URL(s) plus the credit cost
and remaining balance.

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
| `MYARCHITECTAI_TIMEOUT_MS` | no | `120000` | Per-request timeout in ms (1000–600000). |
| `MYARCHITECTAI_MAX_RETRIES` | no | `2` | Retries for transient failures, 0 disables (0–10). |
| `MYARCHITECTAI_DOWNLOAD_DIR` | no | `renders` | Directory `save_image` writes to. |
| `MYARCHITECTAI_MAX_PREVIEW_BYTES` | no | `5000000` | Max bytes `preview_image` embeds inline before falling back to a URL. |
| `MYARCHITECTAI_STATE_FILE` | no | — | Optional path to persist generation history across restarts. |

## Behavior

- **Success** → a text summary listing the generated image URL(s), cost, and balance, plus
  `structuredContent` of the shape `{ output: string[], balance: number, cost: number }`.
- **API/validation errors** (bad input, invalid key, rate limits, server errors) are returned as
  tool results with `isError: true` and a clear message — the server does not crash.
- **Transient failures** (HTTP 408/425/429/5xx, network errors, timeouts) are retried automatically
  with exponential backoff + jitter, honoring `Retry-After`. Client errors (400/401/403) are not retried.

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
