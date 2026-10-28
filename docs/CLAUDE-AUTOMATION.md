# Claude automation

PR reviews use Anthropic's managed Claude Code Review service through the Claude GitHub App. Changeset authoring runs separately in GitHub Actions with Claude Opus 5.5 and `CLAUDE_CODE_OAUTH_TOKEN`.

## Managed reviews

The Claude organisation owns the managed service configuration, repository access, review trigger and billing. Its existing configuration applies to `MyArchitectAI/myarchitectai-api-mcp`; this repository does not run a custom review workflow. Managed reviews do not use this repository's Actions or Dependabot OAuth secrets.

Verify a real review using the **Claude Code Review** check on the PR, including its result and any findings. A successful GitHub Actions job called `review`, an app installation, or a reaction to a comment does not prove that managed review ran. If the configured automatic trigger does not cover an existing PR, a maintainer with write access can post a top-level `@claude review` comment to request one review. This does not change the repository's review trigger.

See [managed review setup](https://code.claude.com/docs/en/code-review-setup) and [review troubleshooting](https://code.claude.com/docs/en/code-review-troubleshooting). Managed reviews run on Anthropic infrastructure and are billed to the Claude organisation through usage credits. Keep the custom review Action removed to avoid duplicate review systems. Changeset authoring still needs the credential below.

## Changeset credential setup

1. An authorised owner follows [Claude's token setup instructions](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token) and runs `claude setup-token` while authenticated to the approved organisation Claude account. Do not reuse a developer's existing local or automation-harness credential.
2. Store the token as `CLAUDE_CODE_OAUTH_TOKEN` in both [Actions secrets](https://github.com/MyArchitectAI/myarchitectai-api-mcp/settings/secrets/actions) and [Dependabot secrets](https://github.com/MyArchitectAI/myarchitectai-api-mcp/settings/secrets/dependabot). Keep both copies aligned when rotating it. Never put the value in source, PRs, logs or artifacts.
3. Keep the existing explicit workflow permissions. GitHub supplies the appropriate same-named secret for each triggering actor; a Dependabot run cannot read the Actions copy.

[GitHub's Dependabot guidance](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions) documents the separate secret stores and explicit token permissions. Manually rerunning a Dependabot run retains its original privilege context.

## Changeset trust boundaries

- The changeset job requires a same-repository PR and skips `changeset-release/main`.
- The Claude action explicitly allows `dependabot[bot]`. Other bots require a separately reviewed allowlist change.
- Events, checkout behavior and permissions remain unchanged. The workflow uses `pull_request`, never `pull_request_target` to expose credentials to PR code.
- The changeset prompt requests only `.changeset/pr-<number>.md`; the commit step stages `.changeset/` and pushes with `GITHUB_TOKEN`, which prevents its commit from recursively triggering workflows.
- The action requires its workflow file to match the trusted default-branch copy. A workflow-changing PR may therefore show a green check while Claude execution was skipped.

## Diagnose the actual failure

| Evidence | Meaning and next action |
| --- | --- |
| `Missing Dependabot secret CLAUDE_CODE_OAUTH_TOKEN` | Configure the Dependabot copy; an Actions secret alone cannot fix this run. |
| `Missing Actions secret CLAUDE_CODE_OAUTH_TOKEN` | Configure the Actions copy for ordinary actor runs. |
| Bot actor rejected | Confirm the trusted workflow explicitly allows `dependabot[bot]`. |
| GitHub app token obtained, followed by HTTP 429 with `usage_limit_reached` | GitHub access succeeded; the changeset account's Claude allowance is exhausted. Check its reset or the approved account's available allowance; this does not establish token expiry or a managed-review failure. |
| Explicit authentication failure, such as an expired/revoked credential or HTTP 401 | Have the authorised owner verify and, if necessary, replace the credential in both stores. |
| Changeset workflow-validation skip | No changeset inference occurred. A green check alone is insufficient evidence. |
| No **Claude Code Review** check | Managed review has not been observed for that PR. Check its trigger or request a review; use the managed-service troubleshooting guide if no check appears. |

## Verify after configuration

1. Confirm a real managed review completes on a PR and the retired review Action does not run. Managed review configuration is independent of the changeset credential.
2. After the changeset workflow change is approved and merged to the default branch, ensure both secret stores are configured. Approval to change workflows does not authorise a production merge or credential rotation.
3. Inspect new genuine Dependabot-triggered and ordinary human PR events using that trusted workflow in [Actions](https://github.com/MyArchitectAI/myarchitectai-api-mcp/actions). A manual rerun of an old workflow does not test the new configuration.
4. Confirm the secret preflight passes, the bot is accepted and Claude actually executes with the intended model. Check for a result without an error; exclude quota failures and validation skips.
5. Confirm changeset authoring makes the appropriate change or no-change decision. A CI-only change may legitimately produce no changeset. If a changeset is committed, confirm no recursive run is created.
