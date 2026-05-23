# Contributing

Thanks for your interest in improving the MyArchitectAI MCP server! This document covers how to
report issues and how to propose changes. By contributing, you agree that your contributions are
licensed under the project's [MIT License](./LICENSE).

Please also read our [Code of Conduct](./CODE_OF_CONDUCT.md). For security issues, **do not** open a
public issue — follow the [Security Policy](./SECURITY.md) instead.

## Reporting issues

- Search [existing issues](https://github.com/MyArchitectAI/myarchitectai-api-mcp/issues) first.
- Use the **Bug report** or **Feature request** template when opening a new one.
- For account, billing, credit, or API-key questions (not MCP bugs), use the
  [MyArchitectAI website](https://www.myarchitectai.com).
- **Never paste your full API key** in an issue. `usage_summary` reports a masked fingerprint that is
  enough to identify the key in use.

## Development setup

Requires Node.js >= 18 and npm.

```bash
# Fork the repo on GitHub, then clone your fork:
git clone https://github.com/<your-username>/myarchitectai-api-mcp.git
cd myarchitectai-api-mcp
git remote add upstream https://github.com/MyArchitectAI/myarchitectai-api-mcp.git
npm install
```

Useful scripts:

| Command | Purpose |
| --- | --- |
| `npm run lint` | ESLint (flat config, `eslint.config.mjs`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Strict type-check of `src` + `test` |
| `npm test` | Unit + integration tests (`node:test`) |
| `npm run dev` | Run the server from source with `tsx` (watch mode) |
| `node scripts/smoke.mjs` | Spawn the built server and list its tools over stdio |

To point an MCP host at your local build instead of the published package, launch `node` with args
`["/absolute/path/to/dist/index.js"]`.

## Proposing changes (pull requests)

We use a standard fork-and-pull-request workflow.

1. Create a topic branch off `main` (e.g. `fix/retry-backoff` or `feat/whoami-tool`).
2. Make your change. Keep it focused — one logical change per PR.
3. **Add or update tests.** New behavior should be covered by `node:test` suites in `test/`.
4. Run the full check suite locally before pushing:
   ```bash
   npm run lint && npm run build && npm run typecheck && npm test
   ```
5. Update the README and `CHANGELOG.md` (`Unreleased` section) when behavior or the public surface
   changes.
6. Push to your fork and open a PR against `main`. Fill out the PR template and link the issue it
   addresses with `Closes #123`.

### What to expect

- CI runs three required checks on every PR — **`lint`**, **`build`**, and **`test`** (the latter two
  across Node 18, 20, and 22). All three must pass.
- PRs from forks run CI automatically; no repository secrets are exposed to fork workflows, and
  publishing is gated behind maintainer-pushed version tags, so fork PRs cannot publish.
- A maintainer will review for correctness, tests, type design, and clear error handling. Small,
  well-tested PRs are reviewed fastest.

## Coding conventions

- **TypeScript, strict.** No `any`, no `@ts-ignore`, no `eslint-disable` to dodge a real issue — fix
  the underlying cause.
- Errors flow through the typed hierarchy in `src/errors.ts`; tool handlers return MCP results with
  `isError: true` rather than throwing to the transport.
- Match the surrounding style; `eslint`/`tsc` are the source of truth. Keep comments about *why*, not
  *what*.
- Commit messages: a concise imperative subject (e.g. `fix: retry 425 responses`). Conventional
  Commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`) are appreciated but not required.

## Releasing

Releases are cut by maintainers — see the **Releasing** section of the [README](./README.md#releasing-maintainers).
