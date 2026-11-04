# Changelog

## Unreleased

- Usage: this week's Bedrock spend from CloudWatch token metrics in `magpie quota`, with Cost Explorer's billed week and month behind an off-by-default switch (Cost Explorer charges per call)
- Optional weekly budget asked at sign-in and kept per account, with its week start; **Stop at weekly budget** switch makes Magpie's routing move to fallbacks once it's spent
- Plugin options for a monthly budget, more metric regions and refresh time
- Spend readings saved in Magpie's config folder, so restarts and `magpie quota` don't ask AWS again
- Geography profiles missing from the catalog are priced from their in-region model instead of $0
- SigV4 signs `x-amz-target` when a request has one
- Icon: the Bedrock logo from LobeHub Icons (MIT), as Magpie's built-in Bedrock provider uses

## 0.3.1

- Publish the rewritten README for the npm page
- Update repository and issue links to `HaroldLeo/magpie-aws-bedrock-sso`

## 0.3.0

First npm release as `magpie-aws-bedrock-sso`. The provider id stays `bedrock-sso`.

- Single OpenCode v1 export (`export default { id, server }`); tests use `_internal`
- Magpie listing fields: `magpie.icon`, keywords (`opencode`, `auth`, `provider`), README sections
- `provider.models` throws `SignInExpired` with `signIn: "expired"`; other credential failures propagate so Magpie keeps its saved catalog
- Package rename and Magpie branding
- README tips for `aws sso login --profile <profile>` and `AWS_CONFIG_FILE` / `AWS_SHARED_CREDENTIALS_FILE`
