# Releasing

Versioning and the changelog are managed with [Changesets](https://github.com/changesets/changesets). `CHANGELOG.md` is only written when you cut a release, so every entry is tied to a published version — never to an in-flight PR.

## Per pull request

Every user-facing PR needs a **changeset**: a small note describing the change and its semver impact (`patch` / `minor` / `major`).

- On **same-repo PRs**, the **Changeset** workflow reads the diff and creates or updates `.changeset/pr-<number>.md` for user-facing changes. See [Claude automation](CLAUDE-AUTOMATION.md).
- Same-repository maintainers should edit `.changeset/pr-<number>.md` directly when a manual correction is needed; do not add a second CLI-generated note for the same change. On **fork PRs**, run `npm run changeset` and commit the generated file.

Internal-only PRs (tests, CI, refactors, repo docs) don't need a changeset.

## Cutting a release

From an up-to-date `main`:

Use Node 24 and npm 10.9 or newer. Changesets 3 requires a supported modern Node/npm toolchain and exits with status 1 when `changeset version` has no pending changesets. If nothing is pending, create the appropriate changeset before starting the version step.

```bash
git pull
npm run changeset:version    # consumes .changeset/*.md → bumps version + writes CHANGELOG.md
git commit -am "chore: version packages"
git push                     # repo admins bypass the PR rule; otherwise open a quick PR and merge
npm run release:tag          # pushes vX.Y.Z → release.yml publishes to npm via OIDC + provenance
```

`release.yml` (npm Trusted Publishing) does the actual publish when the `vX.Y.Z` tag lands.

## Optional: automate the version step

The `npm run changeset:version` + commit step above can be replaced by an auto-maintained **"Version Packages" PR** (the standard [`changesets/action`](https://github.com/changesets/action)). That requires a **MyArchitectAI org owner** to enable _Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"_ — currently **disabled at the org level**, so the workflow is intentionally omitted. Once it's enabled, the release workflow can be added.
