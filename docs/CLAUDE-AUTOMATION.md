# Claude automation

The review and changeset workflows use Claude Opus 5.5 through `CLAUDE_CODE_OAUTH_TOKEN`. Repository maintainers configure the credential; workflow changes do not create or rotate it.

## Credential setup

1. An authorised owner follows [Claude's token setup instructions](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token) and runs `claude setup-token` while authenticated to the approved organisation Claude account. Do not reuse a developer's existing local or automation-harness credential.
2. Store the token as `CLAUDE_CODE_OAUTH_TOKEN` in both [Actions secrets](https://github.com/MyArchitectAI/myarchitectai-api-mcp/settings/secrets/actions) and [Dependabot secrets](https://github.com/MyArchitectAI/myarchitectai-api-mcp/settings/secrets/dependabot). Keep both copies aligned when rotating it. Never put the value in source, PRs, logs or artifacts.
3. Keep the existing explicit workflow permissions. GitHub supplies the appropriate same-named secret for each triggering actor; a Dependabot run cannot read the Actions copy.

[GitHub's Dependabot guidance](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions) documents the separate secret stores and explicit token permissions. Manually rerunning a Dependabot run retains its original privilege context.

## Trust boundaries

- Both jobs require a same-repository PR. The reviewer skips drafts; changeset authoring skips `changeset-release/main`.
- Both Claude actions explicitly allow `dependabot[bot]`. Other bots require a separately reviewed allowlist change.
- Events, checkout behavior and permissions remain unchanged. These workflows use `pull_request`, never `pull_request_target` to expose credentials to PR code.
- The changeset prompt requests only `.changeset/pr-<number>.md`; the commit step stages `.changeset/` and pushes with `GITHUB_TOKEN`, which prevents its commit from recursively triggering workflows.
- The action requires its workflow file to match the trusted default-branch copy. A workflow-changing PR may therefore show a green check while Claude execution was skipped.

## Diagnose the actual failure

| Evidence | Meaning and next action |
| --- | --- |
| `Missing Dependabot secret CLAUDE_CODE_OAUTH_TOKEN` | Configure the Dependabot copy; an Actions secret alone cannot fix this run. |
| `Missing Actions secret CLAUDE_CODE_OAUTH_TOKEN` | Configure the Actions copy for ordinary actor runs. |
| Bot actor rejected | Confirm the trusted workflow explicitly allows `dependabot[bot]`. |
| HTTP 429 with `usage_limit_reached` | The configured account's allowance is exhausted. Check its reset or the approved account's available allowance; this does not establish token expiry. |
| Explicit authentication failure, such as an expired/revoked credential or HTTP 401 | Have the authorised owner verify and, if necessary, replace the credential in both stores. |
| Workflow-validation skip | No review or changeset inference occurred. A green check alone is insufficient evidence. |

## Verify after configuration

1. After the workflow change is approved and merged to the default branch, ensure both secret stores are configured. Approval to change workflows does not authorise a production merge or credential rotation.
2. Inspect new genuine Dependabot-triggered and ordinary human PR events using that trusted workflow in [Actions](https://github.com/MyArchitectAI/myarchitectai-api-mcp/actions). A manual rerun of an old workflow does not test the new configuration.
3. Confirm each secret preflight passes, the bot is accepted and Claude actually executes with the intended model. Check for a result without an error; exclude quota failures and validation skips.
4. Confirm the review completes and changeset authoring makes the appropriate change or no-change decision. A clean review or CI-only change may legitimately produce no comment or changeset. If a changeset is committed, confirm no recursive run is created.
