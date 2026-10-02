# Remote connector preparation

This change supplies a reusable HTTP resource server, a company Vercel entrypoint, a production deployment workflow and synthetic verification. It does not create a Vercel project, deploy `mcp.myarchitectai.com`, enable Supabase OAuth, configure customer bindings, change production charging, or submit a Claude listing. There are no preview deployments. The published stdio package remains independently usable.

## Scope and account boundary

The host authenticates an OAuth access token before resolving any upstream credentials. Each request gets its own MCP server and API client. The reusable factory's `resolveAccount` callback is mandatory and must fail closed when no authorized account mapping exists. The hosted runtime calls the companion Portal bridge, which selects the newest enabled API key owned by that Portal account and rechecks ownership and AWS enabled status on each request. Tool arguments cannot select the account or API key.

The API-facing tools retain their existing USD/API-balance contract. The hosted loader requires an explicit `MCP_BILLING_MODE=api-balance`; there is no default billing mode and no subscription-credit implementation. API users and API balance are the approved scope. Consent copy must identify that charging source. Subscription users are outside this change.

Code discovery on 28 September 2026 found separate billing models:

- API Portal maps an authenticated subject through `clients.user_id` to its owned `api_keys` rows. The database stores `aws_key_id`, not the key value; AWS `GetApiKey` retrieves the enabled key. The Portal bridge checks the newest owned keys in order and bypasses the existing helper’s cache so disabled keys are refused on each request.
- App subscriptions use individual/group subscription credit counters. No per-user bridge to portal wallets was found. The app's guest API integration uses one server credential, which must not become the connector's shared billing identity.

## Portal bridge dependency

The hosted service requires the companion API Portal bridge before live use. Portal retains AWS and database privileges; the MCP uses an internal signing secret and three fixed operations (`account`, `execute`, `health`). Internal assertions use a distinct audience, short expiry and request-body binding. See [HOSTED-RUNTIME.md](HOSTED-RUNTIME.md) for the contract and failure semantics. Paid calls through this intermediary never retry automatically, even for 429/502 responses.

## OAuth configuration

Use Supabase as the authorization server; this module implements only the protected resource. Configure the exact issuer, JWKS endpoint and canonical HTTPS resource URL. Supabase owns native dynamic client registration and user consent; MCP has no separate registration endpoint or client registry. The intended production resource is `https://mcp.myarchitectai.com/mcp`; this URL is a target, not evidence of a live service.

Tokens require a valid asymmetric signature, exact issuer and resource audience, unexpired expiry, nonempty subject and a nonempty exact OAuth `client_id`. A Supabase-registered client can connect after user consent, subject to Portal's owned-account checks. Ordinary application tokens with the `authenticated` audience remain rejected. Configure and verify the resource-audience hook for native OAuth grants before activation, preserving ordinary application tokens. OAuth registration and refresh must be tested against the selected Supabase branch, including revocation behavior.

Revoking the native OAuth grant prevents token renewal. Already-issued access tokens remain valid until their existing `exp`; the provider's current expiry is one hour. MCP preserves that expiry and verifies the JWT locally. Portal checks the user's current account ownership and the selected API key's enabled status on every call.

The public discovery responses identify the authorization server. Missing/invalid bearer authentication returns a 401 challenge pointing to protected-resource metadata. The host must configure its canonical hosts and permitted browser origins; forwarded host headers do not establish trust. GET and DELETE on `/mcp` are unsupported. Request body size, duration and concurrent work are bounded.

The side-effect-free integration entrypoint is `@myarchitectai/mcp/dist/remote.js` after package build/install (or `./dist/remote.js` from this repository). Import `createRemoteServer`, pass `auth` with `canonicalResource`, `issuer` and `jwksUrl`, and provide `resolveAccount(identity, { signal })`. It returns a native Node HTTP server. Identity contains only verified `issuer`, `subject` and `clientId`; the callback returns a user-specific `Config`, a `{ client }` account, or `undefined`. The hosted runtime uses the latter with a Portal transport client. It must pass the supplied cancellation signal to its upstream operations, enforce current ownership, key selection and revocation, and never select an account from tool arguments. The test-only `createClient` override is for synthetic verification.

Client registration alone does not authorize Portal account access. Coordinate Supabase registration, consent and the audience hook. Verify new connection and reconnection behavior before launch; no static client allowlist is required in MCP or Portal.

The HTTP deadline prevents starting a tool after authentication or account lookup has expired. An expired/disconnected account lookup releases request capacity, and any late result is discarded. After tool dispatch, the handler holds request capacity until its operation settles under the API-client deadline. The hosted listener registers this work with Vercel's request lifecycle, but a function termination or platform deadline can still interrupt it; this is not durable background delivery. A disconnected generation may have spent balance. Check the existing API request records and outcome before repeating it; a lost HTTP response is not evidence that the operation was free. Account resolvers must honor cancellation to release their own upstream resources.

## Remote tools

The hosted tool set contains only the 12 existing API operations: `render_exterior`, `render_interior`, `style_transfer`, `text_to_image`, `upscale_4k`, `auto_prompt`, `edit_by_prompt`, `change_textures`, `set_atmosphere`, `animate`, `upscale`, and `balance`. Each authenticated request returns the API result directly. Hosted MCP does not store history or expose `usage_summary`, `list_recent_generations`, `preview_image`, `save_image`, or `validate_image_url`. Stdio retains its existing local history and utilities.

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

The resource server exposes `/health`, includes the deployment revision in process health, and emits structured boundary logs. The hosted `/health/deep` endpoint requires its configured monitoring token and runs bounded cached checks of a Portal database/AWS access and JWKS; it returns 404 when access is not configured or authorized. Process health and the unauthenticated deployment probe do not establish that real consent, account access or paid tools work. No production telemetry credentials are included and no analytics/error events are sent by synthetic verification. Logs exclude bearer tokens, API keys, subjects, prompts, media URLs and upstream response bodies. Operator callbacks receive only sanitized boundary classifications. Configure the company's error monitoring and agree the connector analytics taxonomy before activating capture; do not connect company traffic to this development host's observability services.

## Processing record

Bearer tokens exist only in request memory for validation and are not persisted or forwarded to the generation API. The authorization server owns identity, consent and refresh credentials. The MCP signs a separate, short-lived internal assertion bound to the Portal operation and body. Portal validates it, checks current account/key ownership and enabled status, and obtains the key with its existing AWS access. Only Portal and the generation API receive that API key. No incoming OAuth token is forwarded to Portal. Prompts and media inputs follow the existing API processing contract. Hosted MCP does not persist prompts, output URLs, generated text, usage totals, or token claims. API processing and records remain owned by the existing API services. There are no production rows or credentials in verification fixtures.

## Remaining acceptance work

1. Deploy and verify the companion Portal bridge with the shared internal signing secret and owned-account checks. API users and API balance are the approved scope.
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
