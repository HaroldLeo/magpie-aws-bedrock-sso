# Changelog

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
