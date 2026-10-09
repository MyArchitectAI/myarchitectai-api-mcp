# Hosted runtime: API Portal delegation

The hosted connector runs in the MyArchitectAI company Vercel account. API Portal owns API-account lookup, existing AWS access, API keys and generation billing. The MCP service validates the user’s OAuth token and sends a separately signed internal request to Portal; it never receives customer API keys or Portal’s database credential. The stdio package continues to use the caller’s API key directly.

## Identity and account selection

`PORTAL_SUPABASE_URL` is the public API Portal Supabase origin, used only for OAuth issuer and JWKS discovery. Tokens must match that issuer and the canonical MCP resource audience, and carry a nonempty exact `client_id`. Supabase owns native dynamic client registration and user consent. Registration grants no Portal account access by itself. Ordinary browser session tokens are not accepted as connector tokens. OAuth consent, the resource-audience hook and real connection acceptance remain launch work.

Native grant revocation prevents renewal. Already-issued JWTs remain accepted until their existing `exp`, currently one hour at the provider. MCP preserves that expiry. Portal still checks current account ownership and API-key enabled status on every request.

The product scope is API users and API balance only. `MCP_BILLING_MODE=api-balance` makes that contract explicit. Subscription-user authentication and subscription credits are outside this change.

Portal resolves the signed-in user’s existing API account and selects its newest enabled owned API key. It rechecks ownership and AWS enabled status on each request without the usual key cache. Missing accounts or enabled keys fail closed. No manual per-user connector binding is required.

## Internal transport

MCP requires `PORTAL_BASE_URL` and `MCP_PORTAL_SIGNING_SECRET`. The latter is a separate random credential of at least 32 characters, shared only with Portal. It must not be a Supabase signing key, service-role credential or customer API key. Portal requires the same secret, canonical resource and explicit Portal origin, using its existing database and AWS configuration. The Portal companion change documents its setup in `docs/mcp-bridge.md`.

Each internal JWT uses HS256, the `mcp-portal+jwt` type, the canonical MCP resource as issuer, and `<PORTAL_BASE_URL>/api/mcp` as audience. It expires after 60 seconds and binds the HTTP method, exact operation path and raw request body with SHA-256. User requests carry only the verified OAuth issuer, subject and client ID. The incoming user token is never forwarded. A separate `mcp-service` subject can only call health, without user claims. Assertions are short-lived bearer credentials; a request ID does not provide durable replay or generation idempotency.

`POST /api/mcp/account` checks admission and returns only authorization status. `POST /api/mcp/execute` rechecks account/key ownership and current enabled status, resolves the key inside Portal, and calls the existing generation API with its established billing contract. It preserves output, USD cost/balance, request ID and API error semantics. Callers cannot select an upstream host or override the account. Redirects, oversized responses and requests beyond their deadline are rejected.

Paid operations through Portal have no automatic retries, including 429 and 502: an intermediary failure cannot establish that a generation was uncharged. Read-only balance requests retain bounded retries. Unknown outcomes require checking existing API request records before attempting the generation again.

## Stateless tools and lifecycle

The hosted connector exposes only the 12 existing API operations. Each request uses its verified Portal account and returns the API result directly. It stores no generation history and exposes no history or media utility tools. The stdio package retains its existing local history and utilities.

The Vercel entrypoint retains each accepted request through its registered lifecycle. A disconnected paid call can still complete, while a function termination can interrupt it. A lost HTTP response does not establish that generation was uncharged; check the existing API request records before repeating it.

## Health and observation

`/health` reports process status and deployment revision. Protected `/health/deep` checks Portal database/AWS access and JWKS with bounded caching. Portal’s health probe uses its existing database/AWS access and does not generate or charge. No deep probe certifies every account or a real OAuth connection.

Structured events cover authentication, Portal requests and health. Logs omit internal/user tokens, customer API keys, identities, prompts and raw response bodies. Synthetic checks use fixtures and send no production telemetry. Company monitoring setup and real OAuth/tool acceptance remain required before describing the connector as usable.

## Cross-service verification

With dependencies installed in both companion checkouts, explicitly link the Portal fixture using `ln -s /absolute/path/to/api-portal .portal-smoke`. Then run `npm run build` and `npm run smoke:portal`; finish with `unlink .portal-smoke` to remove only that fixture link. The harness imports this fixed, ignored companion path and does not accept arbitrary module locations. Its dedicated tsx configuration resolves Portal's `@/*` imports through `.portal-smoke`. The harness runs the built MCP and Portal’s actual handler over two loopback HTTP servers. It uses signed synthetic identities and injected database/AWS/API providers to verify account isolation, disabled keys, cost/balance/request IDs, secret confinement, read-only health and no paid retries. Both safety codes are checked for normal generations and auto-prompt, including HTTP 200/429/502 and omission of private provider fields. It makes no cloud calls or real charges. This complements `npm run smoke:remote`; production HTTPS, real consent and authenticated acceptance still require deployment.
