# Security Policy

## Supported versions

Only the latest released version of [`@myarchitectai/mcp`](https://www.npmjs.com/package/@myarchitectai/mcp)
is supported with security fixes. Please upgrade to the latest version before reporting an issue.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull
requests.**

Instead, report them privately through GitHub's
[private vulnerability reporting](https://github.com/MyArchitectAI/myarchitectai-api-mcp/security/advisories/new)
— the **Report a vulnerability** button on the repository's **Security** tab. This creates a private
advisory only you and the maintainers can see.

If you are unable to use GitHub, reach the maintainers through <https://www.myarchitectai.com>.

Please include:

- a description of the vulnerability and its impact,
- steps to reproduce (a minimal proof of concept if possible),
- affected version(s) and environment.

We aim to acknowledge a report within **3 business days** and to share a remediation timeline after
triage. We will credit reporters who wish to be credited once a fix is released.

## A note on API keys

This server reads your `MYARCHITECTAI_API_KEY` from the environment and sends it **only** to the
MyArchitectAI API as the `x-api-key` header over HTTPS. The key is never logged or written to disk,
and `usage_summary` exposes only a masked fingerprint (the last 4 characters).

**When filing any report or issue, never paste your full API key** — the masked fingerprint from
`usage_summary` is enough to identify which key is in use. If you believe a key has been exposed,
rotate it in the [portal](https://portal.myarchitectai.com) immediately.
