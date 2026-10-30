# AWS Bedrock SSO for Magpie

[![npm](https://img.shields.io/npm/v/magpie-aws-bedrock-sso)](https://www.npmjs.com/package/magpie-aws-bedrock-sso)
[![license](https://img.shields.io/npm/l/magpie-aws-bedrock-sso)](https://github.com/HaroldLeo/magpie-aws-bedrock-sso/blob/main/LICENSE)

Use Amazon Bedrock's Claude and GPT models in [Magpie](https://usemagpie.ai) with your AWS SSO / IAM Identity Center profile. No Bedrock API key needed.

[GitHub](https://github.com/HaroldLeo/magpie-aws-bedrock-sso) · [npm](https://www.npmjs.com/package/magpie-aws-bedrock-sso) · [Magpie plugin docs](https://usemagpie.ai/docs/plugins)

## Install

```sh
magpie plugin add magpie-aws-bedrock-sso
magpie plugin login bedrock-sso
magpie provider refresh bedrock-sso
```

Login asks for your AWS profile and Bedrock region. Then pick models:

```sh
magpie provider bedrock-sso                                      # list exposed and hidden models
magpie provider models bedrock-sso +us.anthropic.claude-opus-5-5    # expose an example model
```

Use a model ID from the list in place of the example above.

## Requirements

- Magpie with provider plugin support
- AWS CLI v2 and a profile allowed to list Bedrock inference profiles and invoke the selected models
- Your AWS policies decide which models you can invoke

## Models

After sign-in and refresh, the catalog lists active, system-defined Claude and supported GPT inference profiles visible to your account in the region's geography, plus global ones. Tokyo (`ap-northeast-1`) also includes `jp.*` profiles, and Sydney (`ap-southeast-2`) includes `au.*` profiles. Claude Instant, v2 and 3 profiles are excluded. Before sign-in, Magpie shows a small built-in seed list.

Model names look like `bedrock-sso/us.anthropic.claude-opus-5-5` and `bedrock-sso/us.openai.gpt-6.1-terra`. Claude goes through Bedrock's Anthropic Messages API, and GPT goes through Converse.

Limits and prices come from Magpie's local `amazon-bedrock` catalog for matching model IDs. Otherwise limits are estimates, and unknown prices may appear as zero. Cost estimates are not bills.

## Sign-in

- Uses credentials resolved by `aws configure export-credentials`, including non-SSO profiles and roles without `bedrock:CallWithBearerToken`.
- During Magpie login, `aws sso login` runs only if the AWS CLI reports a missing, invalid or expired SSO session. Later you can sign in again in Magpie or run `aws sso login --profile <profile>`.
- Magpie saves the profile name, region and account label in `~/.config/magpie/plugin-auth.json` (or `$XDG_CONFIG_HOME/magpie/plugin-auth.json`). The sign-in record contains no AWS keys. The plugin keeps exported credentials in memory and refreshes them from the AWS CLI on demand, starting five minutes before expiry. The AWS CLI manages its own credential files and SSO caches.
- `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` are honored.
- If `aws` isn't on Magpie's PATH, set `MAGPIE_BEDROCK_AWS_CLI`. On macOS the plugin also checks Homebrew's usual locations.
- Model requests are SigV4-signed over HTTPS to `bedrock-runtime.<region>.amazonaws.com`. Untrusted hosts, ports, paths and redirects are refused.

## Details

<details>
<summary>GPT adapter support and limits</summary>

Supported: text, base64 image data URLs, function tools, tool results, streaming, and supported reasoning efforts.

Rejected: remote image URLs, image-detail controls, malformed tool arguments, named participants, audio, structured output, strict function schemas, web search, prediction, and disabling parallel tool calls. Unsupported controls it recognizes throw an error. System and developer instructions must come before the conversation, and tool history needs tool definitions. Storage-only fields (`store`, `metadata`, `user`) are not forwarded. Encrypted Bedrock reasoning may not replay. The event-stream decoder checks frame bounds and CRC32, with a 32 MiB client frame cap.

</details>

Magpie is the tested host. Direct OpenCode use is unverified. The `opencode` keyword follows Magpie's discovery convention. The provider ID is `bedrock-sso`.

## Development

```sh
npm test                                                   # offline, Node 20+
AWS_PROFILE=your-profile node test/live.mjs                 # billable Bedrock prompts
MAGPIE_TEST_URL=http://127.0.0.1:3499 node test/gateway-live.mjs
```

Replace `your-profile` with your AWS profile name. Both live scripts send billable Bedrock prompts. `gateway-live.mjs` needs an isolated Magpie with this plugin signed in and its test models exposed (defaults: `bedrock-sso/us.openai.gpt-6.1-terra` and `bedrock-sso/us.anthropic.claude-haiku-5-5`; override with `BEDROCK_GPT_MODEL` and `BEDROCK_CLAUDE_MODEL`).

To install from a local checkout, pass the folder path to `magpie plugin add` instead of the package name, and keep that directory.

## License

MIT
