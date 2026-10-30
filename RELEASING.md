# Releases and auto-merge

## One-time npm setup

In the npm package's [settings](https://www.npmjs.com/package/magpie-aws-bedrock-sso/access), add a **Trusted Publisher** for **GitHub Actions** with these exact values:

- Organization or user: `HaroldLeo`
- Repository: `magpie-aws-bedrock-sso`
- Workflow filename: `publish.yml`
- Environment name: leave blank
- Allowed actions: enable direct publishing with `npm publish`

The workflow must be merged before configuring the publisher. No npm token or OTP is stored in GitHub. See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers).

## Publish a release

1. On a branch, run `npm version patch --no-git-tag-version`, update `CHANGELOG.md`, and commit the changes in a PR. Run the version command once; retries of publishing do not need another version bump.
2. Merge the PR after the required checks pass. You can enable auto-merge while checks run.
3. Update your local `main`, then create and push a tag matching `package.json`. For example, if the merged version is `0.3.4`:

   ```sh
   git switch main
   git pull --ff-only
   git tag -a v0.3.4 -m "Release 0.3.4"
   git push origin v0.3.4
   ```

The **Publish** workflow checks that the tag matches the package version and its commit is on `main`, runs the offline tests and packaging check, then publishes to npm using OIDC. npm adds provenance automatically. Existing versions cannot be overwritten; do not retag a release to retry it. Once a configuration issue is fixed, rerun its failed workflow if that version is still unpublished.

## Auto-merge a PR

Use **Enable auto-merge** on an individual PR, or run:

```sh
gh pr merge 123 --auto --squash
```

Replace `123` with the PR number. GitHub waits for `bun`, `test (20)`, `test (22)`, and `test (24)` to pass, for the branch to be up to date, and for review conversations to be resolved. Required approvals remain at zero, so enabling auto-merge is your decision to merge once those conditions pass. Draft PRs must be marked ready first.
