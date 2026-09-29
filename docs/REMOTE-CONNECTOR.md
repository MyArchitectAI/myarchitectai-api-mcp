# Remote connector preparation

This change supplies a reusable HTTP resource server, a company Vercel entrypoint, a production deployment workflow and synthetic verification. It does not create a Vercel project, deploy `mcp.myarchitectai.com`, enable Supabase OAuth, configure customer bindings, change production charging, or submit a Claude listing. There are no preview deployments. The published stdio package remains independently usable.

## Scope and account boundary

The host authenticates an OAuth access token before resolving any upstream credentials. Each request gets its own MCP server and API client. History belongs to the verified issuer and subject, never a tool argument or a shared API key. The reusable factory's `resolveAccount` callback is mandatory and must fail closed when no authorized account mapping exists. The hosted runtime uses explicit operator-selected API-key IDs and checks current portal ownership and AWS enabled status on each request; it never uses a shared environment API key or chooses the first available key. This is an initial limited-rollout binding mechanism, not a self-service account-selection flow.

The API-facing tools retain their existing USD/API-balance contract. The hosted loader requires an explicit `MCP_BILLING_MODE=api-balance`; there is no default billing mode and no subscription-credit implementation. The product's billing choice remains a launch decision, and consent copy must identify the actual charging source. The supplied API-portal integration only applies when that existing contract is selected.

Code discovery on 28 September 2026 found separate billing models:

- API Portal maps an authenticated subject through `clients.user_id` to a selected active `api_keys` row. The database stores `aws_key_id`, not the key value; AWS `GetApiKey` retrieves the enabled key. The existing playground performs these ownership checks. Multiple keys are supported and `clients.user_id` is not unique, so ambiguous mappings must fail closed and key selection must be explicit. The existing AWS helper caches enabled status for five minutes; a connector needs an intentional revocation policy.
- App subscriptions use individual/group subscription credit counters. No per-user bridge to portal wallets was found. The app's guest API integration uses one server credential, which must not become the connector's shared billing identity.

## OAuth configuration

Use Supabase as the authorization server; this module implements only the protected resource. Configure the exact issuer, JWKS endpoint, canonical HTTPS resource URL and authorized OAuth client IDs. The intended production resource is `https://mcp.myarchitectai.com/mcp`; this URL is a target, not evidence of a live service.

Tokens require a valid asymmetric signature, matching issuer and resource audience, unexpired expiry, nonempty subject and an explicitly allowed OAuth `client_id`. Ordinary app-session tokens are not accepted. Supabase's documented default audience is `authenticated`; configure and verify an access-token hook for the approved connector client IDs that issues the exact MCP resource audience before activation. Do not change the audience of ordinary application tokens. OAuth registration and refresh must be tested against the selected Supabase branch, including revocation behavior.

The public discovery responses identify the authorization server. Missing/invalid bearer authentication returns a 401 challenge pointing to protected-resource metadata. The host must configure its canonical hosts and permitted browser origins; forwarded host headers do not establish trust. GET and DELETE on `/mcp` are unsupported. Request body size, duration and concurrent work are bounded.

The side-effect-free integration entrypoint is `@myarchitectai/mcp/dist/remote.js` after package build/install (or `./dist/remote.js` from this repository). Import `createRemoteServer`, pass `auth` with `canonicalResource`, `issuer`, `jwksUrl` and `allowedOAuthClientIds`, and provide `resolveAccount(identity, { signal })`. It returns a native Node HTTP server. Identity contains only verified `issuer`, `subject` and `clientId`; the callback returns a user-specific `Config` or `undefined`. It must pass the supplied cancellation signal to its upstream operations, enforce current ownership, key selection and revocation, and never select an account from tool arguments. Test-only `createClient`/`createMedia` overrides are for synthetic verification; the default media service enforces remote access restrictions.

Client registration alone does not authorize a client for this resource. Coordinate Supabase registration, consent, the audience hook and the configured client-ID allowlist. Verify new connection and reconnection behavior before enabling dynamic registration publicly; a static allowlist is preparation, not a complete registration lifecycle.

The HTTP deadline prevents starting a tool after authentication or account lookup has expired. An expired/disconnected account lookup releases request capacity, and any late result is discarded. After tool dispatch, the handler holds the user-history lease and request capacity until its operation settles under the API-client deadline. The hosted listener registers this work with Vercel's request lifecycle, but a function termination or platform deadline can still interrupt it; this is not durable background delivery. A disconnected generation may have spent balance. Check recent history and the underlying API request outcome before repeating it; a lost HTTP response is not evidence that the operation was free. Account resolvers must honor cancellation to release their own upstream resources.

## Remote tools and history

The remote tool set omits `save_image`. Image preview stays inline and cannot read local files or launch a browser. Remote network media access permits public HTTPS destinations only, pins a validated public address for each connection and rejects redirects. Use the final public image URL. Stdio retains its local utility behavior.

The reusable factory retains its bounded process-local history option for single-process integration. The Vercel runtime instead uses company-owned Upstash Redis with keys derived from the verified issuer and subject, a separate HMAC secret, and a production namespace. Atomic operations preserve concurrent updates across instances. The history policy retains at most 100 recent records with a 30-minute idle expiry; storage-size bounds may retain fewer records. Reads and writes refresh idle expiry. History availability is checked before tool admission. A storage failure after a successful paid API response is logged without changing that paid success into a retryable tool failure. History queries report unavailable storage honestly.

## Verification

```sh
npm ci
env -u NODE_ENV npm run build
npm run typecheck
npm run lint
npm test
npm run smoke:remote
```

The smoke script uses the built server, a real HTTP MCP client, newly generated test signing keys and synthetic upstream responses. Its listeners bind only to loopback and close on completion. It exercises the remote tools and account separation without real API keys, paid generation, Supabase settings changes or analytics sends. It does not prove that the actual Supabase consent flow or Claude's custom connector works.

## Hosting and observability

Justin's hosting requirement is the MyArchitectAI company's Vercel account. This development machine is not part of the company's runtime infrastructure. The native Node entrypoint and [production workflow](DEPLOYMENT.md) live in this repository. Automatic Vercel Git deployments are disabled for every branch; the workflow validates the source before deploying it to production, then checks the canonical endpoint's revision and authentication discovery. No preview project or workflow is provided. The company's Vercel project and DNS are created separately by the owner.

The resource server exposes `/health`, includes the deployment revision in process health, and emits structured boundary logs. The hosted `/health/deep` endpoint requires its configured monitoring token and runs bounded cached checks of a representative selected account's portal/AWS access, JWKS and Redis; it returns 404 when access is not configured or authorized. Process health and the unauthenticated deployment probe do not establish that real consent, account access or paid tools work. No production telemetry credentials are included and no analytics/error events are sent by synthetic verification. Logs exclude bearer tokens, API keys, subjects, prompts, media URLs and upstream response bodies. Operator callbacks receive only sanitized boundary classifications. Configure the company's error monitoring and agree the connector analytics taxonomy before activating capture; do not connect company traffic to this development host's observability services.

## Processing record

Bearer tokens exist only in request memory for validation and are not persisted or forwarded to the generation API. The authorization server owns identity, consent and refresh credentials. The trusted resolver reads the selected customer's API-key metadata from the company portal and obtains its value from AWS; the generation API receives that credential and the tool input. Prompts and media inputs follow the existing API processing contract. Shared history contains recent output URLs or generated text, timestamps, tool names, costs, balances, optional API request IDs, and aggregate usage. It does not separately store input prompts or token claims. HMAC-keyed identifiers are pseudonymous, not anonymous. Company Redis administrators can read stored content, and runtime/deployment administrators can access the HMAC key and process memory. Idle expiry and record eviction apply to the active Redis store; provider backups and privacy terms require company review before launch. There are no production rows or credentials in verification fixtures.

## Remaining acceptance work

1. Confirm API balance or app subscription credits. API balance requires explicit portal key bindings and live ownership/revocation checks; subscription credits require a separate implementation. Complete self-service account selection before a general directory launch.
2. Build the consent page in the selected identity host; show the client, requested access and the actual charging source, and support approve/deny and login return paths.
3. Enable OAuth and client registration on a Supabase branch, configure the resource audience, and verify discovery, PKCE, tokens, refresh, denial and revocation with real branch credentials.
4. The user excluded preview deployments. Complete local synthetic verification, create and configure the company Vercel project, then obtain explicit production promotion approval. Verify the real connection in MCP Inspector and Claude against a designated reviewer account, including insufficient balance and failed-generation cases. Paid verification calls require their own authorization.
5. Prepare a funded reviewer account, public documentation/privacy updates, icon, support contact and listing text. Kacper owns directory submission. State generation charges and the free balance lookup plainly once the billing contract is settled.
6. Obtain explicit MyArchitectAI production promotion approval before enabling the real service. No publication, release tag, production push, schema change or Vercel project creation is included in this preparation work.

## Verified references

- [Supabase OAuth setup and consent](https://supabase.com/docs/guides/auth/oauth-server/getting-started)
- [Supabase OAuth token claims and audience hooks](https://supabase.com/docs/guides/auth/oauth-server/token-security)
- [Supabase MCP discovery](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication)
- [MCP authorization requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Claude connector submission](https://claude.com/docs/connectors/building/submission)

Checked 28 September 2026. Claude's current submission page permits any paid plan, requires a remote HTTPS server, working authentication, annotated tools, tool testing and a usable reviewer account. Its current listing one-liner limit is 200 characters. These differ from the older Team/Enterprise-only and 55-character statements in the ticket.
