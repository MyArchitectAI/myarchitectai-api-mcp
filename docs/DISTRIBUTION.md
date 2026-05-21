# Distribution & Host Coverage

How this MCP server can be added to the various agent hosts, and the strategy
for covering them. **Current focus: the Claude ecosystem.** The OpenAI/Codex and
other-host sections are captured here for later — they are *not yet implemented*.

Researched May 2026; flag anything that looks stale before relying on it.

## TL;DR strategy

- **One tool core, two transports.** Write the tools once; expose them over:
  - **stdio** — covers every *local* host (Claude Code, Claude Desktop, Codex, Cursor, Windsurf, VS Code). This is what we ship today.
  - **Streamable HTTP (+ OAuth)** — required for *browser* hosts (claude.ai, ChatGPT). Not built yet.
- **SSE is deprecated** protocol-wide; if/when we add a network transport, use **Streamable HTTP**, not SSE.
- **Packaging is per-host** on top of the same server: npm package (universal for stdio configs via `npx`), a Claude Code plugin, a Claude Desktop `.mcpb` bundle, and a hosted HTTP deployment for the web hosts.

## Host matrix

| Host | How a user adds it | Transport(s) | Notes |
| --- | --- | --- | --- |
| **Claude Code** | `.mcp.json` / `claude mcp add`, or a **plugin** | stdio · HTTP | Our current target. |
| **Claude Desktop** | `claude_desktop_config.json`, or a **`.mcpb`** bundle (Extensions) | stdio · HTTP | Built-in Node runtime for bundles. |
| **claude.ai (web)** | Settings → Connectors (remote) | **HTTP + OAuth only** | No stdio. ~150k char tool-result cap. |
| **ChatGPT (web)** | Developer Mode connector (remote) | **HTTP only** (OAuth optional) | No stdio. Plus/Pro/Team/Enterprise. |
| **Codex (CLI/IDE)** | `~/.codex/config.toml` / `codex mcp add`, or a **Codex plugin** | stdio · HTTP | Plugin system added v0.117 (Mar 2026). |
| **Cursor** | `~/.cursor/mcp.json` (key `mcpServers`) | stdio · HTTP | — |
| **Windsurf** | `~/.codeium/mcp_config.json` (key `mcpServers`) | stdio · HTTP | — |
| **VS Code (Copilot)** | `.vscode/mcp.json` (key **`servers`**) | stdio · HTTP | Key is `servers`, *not* `mcpServers`. |

Rule of thumb: **stdio covers all local CLI/desktop hosts; the two browser hosts (claude.ai, ChatGPT) accept only remote HTTP.** Publishing to npm unlocks every stdio host at once (they just `npx` it).

---

## Claude ecosystem (current focus)

### Claude Code

- **Direct:** project `.mcp.json` (committed in this repo) enabled via `.claude/settings.local.json` (`enableAllProjectMcpServers` / `enabledMcpjsonServers`), or `claude mcp add`.
- **Plugin:** bundle the MCP server + skills + slash commands + subagents + hooks.

  ```
  myarchitectai-plugin/
  ├── .claude-plugin/plugin.json     # manifest (name, version, description, author)
  ├── .mcp.json                      # MCP server(s), using ${CLAUDE_PLUGIN_ROOT}
  ├── skills/<name>/SKILL.md          # e.g. an image-compare skill
  ├── commands/<name>.md              # optional slash commands
  └── hooks/hooks.json                # optional
  ```

  Plugin `.mcp.json` (server bundled with the plugin):
  ```json
  {
    "mcpServers": {
      "myarchitectai": {
        "command": "node",
        "args": ["${CLAUDE_PLUGIN_ROOT}/dist/index.js"],
        "env": { "MYARCHITECTAI_API_KEY": "${MYARCHITECTAI_API_KEY}" }
      }
    }
  }
  ```

  Useful expansions: `${CLAUDE_PLUGIN_ROOT}` (bundled files), `${CLAUDE_PLUGIN_DATA}` (persistent state across updates), `${CLAUDE_PROJECT_DIR}`.

- **Distribution:** a marketplace = a git repo with `.claude-plugin/marketplace.json` listing plugins. Install via `/plugin marketplace add owner/repo` then `/plugin install name@marketplace`. Validate with `claude plugin validate`. Local dev: `claude --plugin-dir ./myarchitectai-plugin`.

### Claude Desktop

- **Config file:**
  - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
  - Linux: `~/.config/Claude/claude_desktop_config.json`
  - UI: Settings → Developer → Edit Config.
- **`.mcpb` bundle (Desktop Extensions):** one-click install (Settings → Extensions). Contains a `manifest.json` + bundled `node_modules`; secrets marked `"sensitive": true` are stored in the OS keychain. Preferred over manual JSON for end users.

### claude.ai (web)

- **Custom Connectors** (Settings → Connectors): **remote MCP only**, **Streamable HTTP**, **OAuth 2.0** (dynamic client registration or pre-configured creds). No stdio. Team/Enterprise gate connector management to admins. Requires a hosted HTTPS deployment — **not built yet**.

### Skills vs. tools (applies to compare, etc.)

- **Tool (MCP):** external system access, bidirectional, must work across all hosts. → the 5 render tools, plus QoL tools that fetch/host/save.
- **Skill:** pure instruction/orchestration where the model is self-sufficient. The model is multimodal, so **image comparison is a skill**: use `preview_image` to put images in context, then the skill guides the evaluation. A pixel-diff/perceptual-hash *tool* is only warranted for objective diffs (needs an image lib). Skills exist in Claude Code (and Codex); claude.ai/ChatGPT have no skill system, so there it falls back to tool descriptions.

---

## Deferred: OpenAI & other hosts (captured, not yet implemented)

### ChatGPT (OpenAI)

- Full MCP client support (read + write) via **Developer Mode**. **Remote only** — must be a hosted HTTPS endpoint; a local stdio server cannot be added (tunnel for dev with ngrok/Cloudflare Tunnel).
- Transport: **Streamable HTTP** (SSE also listed but legacy). Auth: **OAuth supported, not required** (modes: OAuth / None / Mixed).
- The old `search`+`fetch`-only restriction is **gone in Developer Mode** (arbitrary tools; write actions confirm per-call). `search`+`fetch` convention still applies specifically to **Deep Research / "company knowledge"** connectors.
- Plans: Plus, Pro, Team/Business, Enterprise, Edu (admin must enable for workspaces).

### OpenAI Codex (CLI / IDE extension)

- **MCP supported (stdio + remote).** Config in `~/.codex/config.toml` (global) or `.codex/config.toml` (project, trusted). CLI and IDE share config.

  ```toml
  [mcp_servers.myarchitectai]
  command = "npx"
  args = ["-y", "myarchitectai-mcp"]
  env = { MYARCHITECTAI_API_KEY = "value" }   # static
  env_vars = ["MYARCHITECTAI_API_KEY"]         # or forward from environment
  # startup_timeout_sec = 10.0
  # tool_timeout_sec = 60.0
  ```

  CLI shortcut: `codex mcp add myarchitectai --env MYARCHITECTAI_API_KEY=... -- npx -y myarchitectai-mcp`

  Remote form:
  ```toml
  [mcp_servers.myarchitectai]
  url = "https://mcp.example.com/mcp"
  bearer_token_env_var = "OAUTH_TOKEN"   # optional
  ```

- **Plugin system (v0.117.0, ~Mar 2026):** manifest-driven bundle (`plugin.json`) packaging **skills + MCP servers + app connectors + hooks**, with a **marketplace** (`codex marketplace add`) and a built-in `@plugin-creator` scaffold skill — directly analogous to Claude Code plugins. So our plugin concept ports to Codex. `AGENTS.md` remains the lowest-friction plain-instructions option.

### Cursor / Windsurf / VS Code

| Host | Config | stdio | Remote | Gotcha |
| --- | --- | --- | --- | --- |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` | yes | HTTP/SSE | key `mcpServers` |
| Windsurf | `~/.codeium/mcp_config.json` | yes | HTTP/SSE | key `mcpServers`; env interpolation |
| VS Code (Copilot) | `.vscode/mcp.json` or user profile | yes (`type:"stdio"`) | HTTP→SSE fallback | **key `servers`** (not `mcpServers`) |

---

## Packaging checklist (by priority for a Claude-first rollout)

1. **npm package** — unlocks all stdio hosts via `npx`. (Gated on choosing the final package name.)
2. **Claude Code plugin** (+ marketplace) — bundles MCP + compare skill + slash command(s).
3. **Claude Desktop `.mcpb`** bundle — one-click install.
4. **Remote Streamable HTTP + OAuth deployment** — unlocks claude.ai (and later ChatGPT). Largest lift.
5. *(Later)* **Codex plugin** — same artifacts as the Claude Code plugin, ported.

## Sources

Claude ecosystem:
- https://code.claude.com/docs/en/plugins.md
- https://code.claude.com/docs/en/mcp
- https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop
- https://claude.com/docs/connectors/building
- https://modelcontextprotocol.io/docs/learn/architecture

OpenAI / other hosts:
- https://developers.openai.com/api/docs/guides/developer-mode
- https://developers.openai.com/api/docs/mcp
- https://developers.openai.com/codex/mcp
- https://developers.openai.com/codex/config-reference
- https://developers.openai.com/codex/plugins
- https://developers.openai.com/codex/guides/agents-md
- https://cursor.com/docs/mcp
- https://docs.windsurf.com/plugins/cascade/mcp
- https://code.visualstudio.com/docs/copilot/customization/mcp-servers
