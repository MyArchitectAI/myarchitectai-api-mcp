# Remote connector preparation

This change supplies a reusable HTTP resource server and synthetic verification. It does not deploy `mcp.myarchitectai.com`, enable Supabase OAuth, bind customer accounts, change charging, or submit a Claude listing. The published stdio package remains independently usable.

## Scope and account boundary

The host authenticates an OAuth access token before resolving any upstream credentials. Each request gets its own MCP server and API client. History belongs to the verified issuer and subject, never a tool argument or a shared API key. The host's `resolveAccount` callback is mandatory and must fail closed when no authorized account mapping exists. No account resolver is supplied by environment fallback.

The API-facing tools retain their existing USD/API-balance contract. This foundation does not claim to charge subscription credits. The product must choose the billing source before implementing the real resolver and consent copy.

Code discovery on 28 September 2026 found separate billing models:

- API Portal maps an authenticated subject through `clients.user_id` to a selected active `api_keys` row. The database stores `aws_key_id`, not the key value; AWS `GetApiKey` retrieves the enabled key. The existing playground performs these ownership checks. Multiple keys are supported and `clients.user_id` is not unique, so ambiguous mappings must fail closed and key selection must be explicit. The existing AWS helper caches enabled status for five minutes; a connector needs an intentional revocation policy.
- App subscriptions use individual/group subscription credit counters. No per-user bridge to portal wallets was found. The app's guest API integration uses one server credential, which must not become the connector's shared billing identity.

## OAuth configuration

Use Supabase as the authorization server; this module implements only the protected resource. Configure the exact issuer, JWKS endpoint, canonical HTTPS resource URL and authorized OAuth client IDs. The intended production resource is `https://mcp.myarchitectai.com/mcp`; this URL is a target, not evidence of a live service.

Tokens require a valid asymmetric signature, matching issuer and resource audience, unexpired expiry, nonempty subject and an explicitly allowed OAuth `client_id`. Ordinary app-session tokens are not accepted. Supabase's documented default audience is `authenticated`; configure and verify an access-token hook for the approved connector client IDs that issues the exact MCP resource audience before activation. Do not change the audience of ordinary application tokens. OAuth registration and refresh must be tested against the selected Supabase branch, including revocation behavior.

The public discovery responses identify the authorization server. Missing/invalid bearer authentication returns a 401 challenge pointing to protected-resource metadata. The host must configure its canonical hosts and permitted browser origins; forwarded host headers do not establish trust. GET and DELETE on `/mcp` are unsupported. Request body size, duration and concurrent work are bounded.

The side-effect-free integration entrypoint is `@myarchitectai/mcp/dist/remote.js` after package build/install (or `./dist/remote.js` from this repository). Import `createRemoteServer`, pass `auth` with `canonicalResource`, `issuer`, `jwksUrl` and `allowedOAuthClientIds`, and provide `resolveAccount(identity, { signal })`. It returns a native Node HTTP server. Identity contains only verified `issuer`, `subject` and `clientId`; the callback returns a user-specific `Config` or `undefined`. It must pass the supplied cancellation signal to its upstream operations, enforce current ownership, key selection and revocation, and never select an account from tool arguments. Test-only `createClient`/`createMedia` overrides are for synthetic verification; the default media service enforces remote access restrictions.

Client registration alone does not authorize a client for this resource. Coordinate Supabase registration, consent, the audience hook and the configured client-ID allowlist. Verify new connection and reconnection behavior before enabling dynamic registration publicly; a static allowlist is preparation, not a complete registration lifecycle.

The HTTP deadline prevents starting a tool after authentication or account lookup has expired. An expired/disconnected account lookup releases request capacity, and any late result is discarded. If the deadline expires after tool dispatch, the connection closes while the already-started operation completes under its API-client deadline; its user-history lease and capacity remain held until completion. A disconnected generation may have spent balance. Check recent history and the underlying API request outcome before repeating it; a lost HTTP response is not evidence that the operation was free. Account resolvers must honor cancellation to release their own upstream resources.

## Remote tools and history

The remote tool set omits `save_image`. Image preview stays inline and cannot read local files or launch a browser. Remote network media access permits public HTTPS destinations only, pins a validated public address for each connection and rejects redirects. Use the final public image URL. Stdio retains its local utility behavior.

History is bounded process-local storage, partitioned by verified issuer and subject. It survives separate HTTP requests to the same process, not a process restart. Do not run multiple instances while promising unified history. The host configures user capacity, record capacity and idle expiry; in-flight operations hold leases so their histories cannot be evicted underneath them. Expired inactive stores are removed when the next request acquires a store; expiry is not a background erasure job. Durable history and cross-instance coordination are outside this preparation change.

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

Host the real integration as a server/container service on the approved backend host, with an HTTPS tunnel and runtime budget for generation. The HTTP factory itself does not install a service. Keep deployment checkouts and runtime data outside development worktrees. Before production activation, add the concrete service to the host's observability manifest and wire its error callback to the product error sink with the supplied fingerprint and safe request context.

The resource server exposes `/health` and `/health/deep` and emits structured boundary logs. These are local diagnostics. No production telemetry credentials are included and no analytics/error events are sent by the synthetic verification. Logs must exclude bearer tokens, API keys, subjects, prompts, media URLs and upstream response bodies. Operator callbacks receive only sanitized boundary classifications. Agree the connector analytics taxonomy before activating capture.

## Processing record

Bearer tokens exist only in request memory for validation and are not persisted or forwarded to the generation API. The authorization server owns identity, consent and refresh credentials. The trusted resolver accesses the selected customer's API credential; the generation API receives that credential and the tool input. Prompts and media inputs follow the existing API processing contract. Recent outputs, timestamps, tool names and costs remain in the user's bounded in-process history until record eviction, lazy idle-store cleanup or process exit. Runtime administrators can access process memory; this module does not promise administrator exclusion or durable erasure guarantees. Product privacy copy and retention terms require review before launch.

## Remaining acceptance work

1. Choose API balance or app subscription credits, then implement that account/charging integration without a shared fallback account.
2. Build the consent page in the selected identity host; show the client, requested access and the actual charging source, and support approve/deny and login return paths.
3. Enable OAuth and client registration on a Supabase branch, configure the resource audience, and verify discovery, PKCE, tokens, refresh, denial and revocation with real branch credentials.
4. Deploy a nonproduction integration through the owning product's approved preview/deploy path and call every tool in MCP Inspector and Claude, including insufficient balance and failed-generation cases.
5. Prepare a funded reviewer account, public documentation/privacy updates, icon, support contact and listing text. Kacper owns directory submission. State generation charges and the free balance lookup plainly once the billing contract is settled.
6. Obtain explicit MyArchitectAI production promotion approval before enabling the real service. No publication, release tag, production push or schema change is included in this work.

## Verified references

- [Supabase OAuth setup and consent](https://supabase.com/docs/guides/auth/oauth-server/getting-started)
- [Supabase OAuth token claims and audience hooks](https://supabase.com/docs/guides/auth/oauth-server/token-security)
- [Supabase MCP discovery](https://supabase.com/docs/guides/auth/oauth-server/mcp-authentication)
- [MCP authorization requirements](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Claude connector submission](https://claude.com/docs/connectors/building/submission)

Checked 28 September 2026. Claude's current submission page permits any paid plan, requires a remote HTTPS server, working authentication, annotated tools, tool testing and a usable reviewer account. Its current listing one-liner limit is 200 characters. These differ from the older Team/Enterprise-only and 55-character statements in the ticket.
