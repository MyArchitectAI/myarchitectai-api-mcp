# Claude automation

PR reviews and automatic changeset authoring use the **Claude Review** and **Changeset** GitHub Actions with Claude Opus 5.5 and the repository's `CLAUDE_CODE_OAUTH_TOKEN`. Both workflows are enabled; Dependabot-triggered runs use the separate same-named Dependabot secret.

## Required checks and workflow state

The production ruleset requires `lint`, `build` and `test`. The token-based `review`, managed **Claude Code Review** and `changeset` checks are not required. Credential failures, allowance failures and workflow-validation skips are not successful model execution.

Inspect each workflow's `state` in GitHub Actions to verify it is active. The changeset author handles same-repository PRs automatically; maintainers correct its `.changeset/pr-<number>.md` file directly rather than adding a second note. Fork contributors use `npm run changeset`; see [Releasing](RELEASING.md).

Justin approved re-enabling Changeset on 28 October 2026 after the replacement Actions token completed a [real review run](https://github.com/MyArchitectAI/myarchitectai-api-mcp/actions/runs/40685795739/attempts/2). The workflow was enabled in repository settings, and the catch-up runs for [the deployment PR](https://github.com/MyArchitectAI/myarchitectai-api-mcp/actions/runs/40329871567/attempts/3) and [the API usage PR](https://github.com/MyArchitectAI/myarchitectai-api-mcp/actions/runs/40675281897/attempts/2) both checked out their current heads and executed Claude successfully. The first needed no note; the second already had an accurate patch note. Neither run added duplicate notes or published a package.

## Token-based reviews

The restored review workflow preserves its existing prompt, review plugin, model and permissions. It runs on same-repository, non-draft PRs when opened or marked ready for review. Pushing commits alone does not trigger it. Fork PRs cannot access the repository OAuth secret and are excluded.

The GitHub App provides GitHub access; `CLAUDE_CODE_OAUTH_TOKEN` authorises Claude inference. Installing the App does not replace the token or change its account's allowance. A successful app-token exchange followed by `usage_limit_reached` is a Claude allowance failure, not proof of a broken GitHub connection.

The Action's workflow file must match its trusted default-branch copy. A green workflow-validation skip does not prove that Claude ran. After the token is updated, use a new eligible PR event and inspect the job log for actual review execution.

## Credential setup

1. An authorised owner follows [Claude's token setup instructions](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token) and runs `claude setup-token` while authenticated to the approved organisation Claude account. Do not reuse a developer's existing local or automation-harness credential.
2. Store the token as `CLAUDE_CODE_OAUTH_TOKEN` in both [Actions secrets](https://github.com/MyArchitectAI/myarchitectai-api-mcp/settings/secrets/actions) and [Dependabot secrets](https://github.com/MyArchitectAI/myarchitectai-api-mcp/settings/secrets/dependabot). Keep both copies aligned when rotating it. Never put the value in source, PRs, logs or artifacts.
3. Verify the credential's account has available allowance. GitHub supplies the appropriate same-named secret for each triggering actor; a Dependabot run cannot read the Actions copy. Manually rerunning a Dependabot job retains its original privilege context.

See [GitHub Actions authentication](https://code.claude.com/docs/en/github-actions) and [GitHub's Dependabot guidance](https://docs.github.com/en/code-security/reference/supply-chain-security/troubleshoot-dependabot/dependabot-on-actions).

## Managed service is separate

The managed Code Review service uses the Claude organisation's review billing or promotional entitlement, not the repository token. Justin chose to return to the token-based Action after confirming the managed review offer does not apply.

To stop duplicate managed-review requests, the Claude organisation owner can turn off Code review for this repository in [Admin settings > Claude Code](https://claude.ai/admin-settings/claude-code). Keep the GitHub App installed: the restored Action also uses it for GitHub access. This repository change does not alter the organisation's managed-service settings. See [turn off managed reviews for a repository](https://code.claude.com/docs/en/code-review-setup#turn-off-code-review-or-remove-a-repository).

## Changeset authoring and catch-up

The changeset workflow has a same-repository guard, explicit Dependabot allowance and credential preflight. It uses `pull_request`, never `pull_request_target` to expose credentials to PR code. Runs are serialized per PR, retaining the latest pending event without cancelling an in-progress push and CI dispatch. Its commit step pushes with `GITHUB_TOKEN`, then explicitly dispatches the existing `ci.yml` workflow for the updated branch so required checks run on the generated commit without starting another Claude job. No-change runs do not dispatch CI, and a failed push or dispatch fails the job.

The workflow runs when a PR is opened, synchronized or reopened. After a pause or credential outage, review the open PRs and the merged changes since the latest release. Reuse accurate `.changeset/pr-<number>.md` notes and changes already covered by `CHANGELOG.md`; internal-only PRs need no note. Catch-up should not duplicate existing release entries or publish a package.

If a PR has no previous run, trigger a new eligible event by pushing its next change or reopening it. If an old run fails trusted-workflow validation, first ensure the PR's workflow matches the default branch, then use a new eligible event. For any rerun, confirm the checkout and PR diff reflect the current branch, then inspect the log for actual Claude execution and the appropriate changeset or no-change decision. A validation skip is not a completed catch-up. Re-enabling a workflow does not make its check required.
