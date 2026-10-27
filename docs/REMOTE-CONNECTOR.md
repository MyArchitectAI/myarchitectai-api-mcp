# Remote connector preparation

This repository supplies a reusable HTTP resource server, the company Vercel entrypoint, a production deployment workflow and synthetic verification. Hosted OAuth uses the companion API Portal authorization server and its consent grants. The published stdio package continues to use the caller's API key. This document describes the implementation; deployed revisions and real connector acceptance need separate evidence.

## Scope and account boundary

The host authenticates an OAuth access token before resolving any upstream credentials. Each request gets its own MCP server and API client. The reusable factory's `resolveAccount` callback is mandatory and must fail closed when no authorized account mapping exists. The hosted runtime calls the companion Portal bridge, which selects the newest enabled API key owned by that Portal account and rechecks ownership and AWS enabled status on each request. Tool arguments cannot select the account or API key.

The API-facing tools retain their existing USD/API-balance contract. The hosted loader requires an explicit `MCP_BILLING_MODE=api-balance`; there is no default billing mode and no subscription-credit implementation. API users and API balance are the approved scope. Consent copy must identify that charging source. Subscription users are outside this change.

Code discovery on 28 September 2026 found separate billing models:

- API Portal maps an authenticated subject through `clients.user_id` to its owned `api_keys` rows. The database stores `aws_key_id`, not the key value; AWS `GetApiKey` retrieves the enabled key. The Portal bridge checks the newest owned keys in order and bypasses the existing helper’s cache so disabled keys are refused on each request.
- App subscriptions use individual/group subscription credit counters. No per-user bridge to portal wallets was found. The app's guest API integration uses one server credential, which must not become the connector's shared billing identity.

## Portal bridge dependency

The hosted service requires the companion API Portal bridge before live use. Portal retains AWS and database privileges; the MCP uses an internal signing secret and three fixed operations (`account`, `execute`, `health`). Internal assertions use a distinct audience, short expiry and request-body binding. See [HOSTED-RUNTIME.md](HOSTED-RUNTIME.md) for the contract and failure semantics. Paid calls through this intermediary never retry automatically, even for 429/502 responses.

## OAuth configuration

For the company-hosted connector, configure `PORTAL_BASE_URL` as the HTTPS Portal origin and issuer, `MCP_CANONICAL_RESOURCE` as the exact MCP endpoint, and `MCP_PORTAL_SIGNING_SECRET` as a server-only credential shared with Portal. No Supabase issuer/JWKS configuration is used by hosted MCP. Protected-resource metadata identifies the Portal authorization server; its metadata exposes registration, authorization, token and revocation endpoints.

Portal supports public clients using S256 PKCE authorization code and refresh grants. Authorization and token requests require the exact configured resource. Registration accepts HTTPS and HTTP loopback redirects without credentials or fragments; callbacks must match registration, apart from loopback port variation. A registration does not authorize account access. The browser signs in through Portal and explicitly approves a nonempty subset of requested API scopes or denies. Omitted scope defaults to `balance:read`; `openid` and account-management scopes are unsupported.

Portal issues dedicated HS256 access tokens with `typ=mcp-access+jwt`, a domain-separated signing key and at most fifteen minutes of lifetime. MCP validates the exact issuer, scalar resource audience, subject, client ID, grant ID, allowed claims and approved scopes. The token endpoint returns approved scope and a rotating opaque refresh token without a Supabase access/refresh/ID token. Grants expire thirty days after code exchange. Refresh retains or reduces scope and cannot extend grant expiry; code and refresh replay revoke the grant family.

MCP rejects unapproved tool calls with an `insufficient_scope` challenge. Portal checks the live grant on every account lookup and execution and requires the endpoint scope in both the token identity and persisted grant. Explicit revocation blocks subsequent calls even while an access token has time remaining. Portal also checks current account ownership and enabled keys. A generation already dispatched can still complete and charge. Existing API key scopes and expiry remain independent of the MCP consent grant.

Missing or invalid bearer authentication returns a 401 challenge pointing to protected-resource metadata. Configure canonical hosts and permitted browser origins; forwarded host headers do not establish trust. GET and DELETE on `/mcp` are unsupported. Request body size, duration and concurrent work are bounded.

The side-effect-free integration entrypoint is `@myarchitectai/mcp/dist/remote.js` after package build/install. `createRemoteServer` accepts `auth`, an optional `authenticate` callback and a required `resolveAccount(identity, { signal })`. The generic factory retains its asymmetric/JWKS authenticator for custom integrations and synthetic tests. The hosted loader supplies its dedicated resource-token authenticator and scope metadata; do not use the generic default as the hosted configuration. Hosted identity contains verified `issuer`, `subject`, `clientId`, `grantId` and `scopes`. The resolver returns a user-specific `Config`, a `{ client }` account, or `undefined`; hosted MCP uses a Portal transport client. Resolvers must honor cancellation and fail closed rather than selecting an account from tool arguments.

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

The smoke script uses the built server, a real HTTP MCP client, newly generated test signing keys and synthetic upstream responses. Its listeners bind only to loopback and close on completion. It exercises the remote tools and account separation without real API keys, paid generation, Supabase settings changes or analytics sends. It does not prove Portal's deployed consent flow or a real custom connector works. Run `npm run smoke:portal` with the companion checkout to cover the hosted resource-token and live-grant path.

## Hosting and observability

Justin's hosting requirement is the MyArchitectAI company's Vercel account. This development machine is not part of the company's runtime infrastructure. The native Node entrypoint and [production workflow](DEPLOYMENT.md) live in this repository. Automatic Vercel Git deployments are disabled for every branch; the workflow validates the source before deploying it to production, then checks the canonical endpoint's revision and authentication discovery. No preview project or workflow is provided. Reuse the company's existing Vercel project and DNS configuration.

The resource server exposes `/health`, includes the deployment revision in process health, and emits structured boundary logs. The hosted `/health/deep` endpoint requires its configured monitoring token and checks Portal database, OAuth grant-table access and AWS metadata; it returns 404 when access is not configured or authorized. Process health and the unauthenticated deployment probe do not establish that real consent, account access or paid tools work. No production telemetry credentials are included and no analytics/error events are sent by synthetic verification. Logs exclude bearer tokens, API keys, subjects, prompts, media URLs and upstream response bodies. Operator callbacks receive only sanitized boundary classifications. Configure the company's error monitoring and agree the connector analytics taxonomy before activating capture; do not connect company traffic to this development host's observability services.

## Processing record

Bearer tokens exist only in request memory for validation and are not persisted or forwarded to the generation API. The authorization server owns identity, consent and refresh credentials. The MCP signs a separate, short-lived internal assertion bound to the Portal operation and body. Portal validates it, checks current account/key ownership and enabled status, and obtains the key with its existing AWS access. Only Portal and the generation API receive that API key. No incoming OAuth token is forwarded to Portal. Prompts and media inputs follow the existing API processing contract. Hosted MCP does not persist prompts, output URLs, generated text, usage totals, or token claims. API processing and records remain owned by the existing API services. There are no production rows or credentials in verification fixtures.

## Coordinated release and acceptance

1. Prepare reviewed companion Portal and MCP revisions with matching Portal origin, canonical resource and shared-secret references. The Portal migration and hosted token format must ship together; mixed versions reject authentication. Follow the private Portal release checklist for identity-provider cutover and existing-session handling.
2. Verify synthetic registration, S256 PKCE, exact resource/callback matching, selected scopes, denial, refresh/downscoping, replay-family revocation and explicit revocation. Browser checks must cover login return, empty selection and recoverable failure states with an isolated reviewer account. No paid call or production setting change is implied by these checks.
3. Obtain explicit authorization for each MyArchitectAI production promotion and production schema/configuration action. Verify exact deployed revisions and discovery, then exercise the real connector with a designated reviewer account. Paid verification calls require separate authorization; process health alone does not prove consent or authenticated tools.
4. Keep directory assets, support contacts and funded reviewer-account preparation separate from code readiness. Record unresolved acceptance work before describing the connector as usable. The stdio package retains its existing API-key behavior.
