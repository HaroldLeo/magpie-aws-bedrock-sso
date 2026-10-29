# AWS Bedrock SSO

Package name: `magpie-aws-bedrock-sso`. The provider ID remains `bedrock-sso`, so existing model selections do not change.

Amazon Bedrock in Magpie, signed with AWS Signature Version 4 from an AWS CLI profile. No Bedrock bearer API key.

Magpie is the tested host. Direct OpenCode use is unverified. The `opencode` search keyword follows Magpie's discovery convention and does not claim OpenCode support.

This is a candidate release. The repository stays private while distribution permission is unresolved. There is no published npm package.

## What it signs in to

Amazon Bedrock, through an AWS CLI profile (SSO / IAM Identity Center, or any profile `aws configure export-credentials` can resolve). Roles that lack `bedrock:CallWithBearerToken` can still call Bedrock.

## How

`magpie plugin login bedrock-sso` asks for the AWS profile and Bedrock region, then uses `aws sso login` only if that profile's session has run out. The AWS CLI opens its own browser when needed. When the session expires later, sign in again in Magpie or run `aws sso login --profile <profile>`. Every request is SigV4-signed over HTTPS to `bedrock-runtime.<region>.amazonaws.com`. Untrusted hosts, ports, paths, and redirects are refused.

## Where the sign-in is kept

Magpie stores the profile name, region, and account label in `~/.config/magpie/plugin-auth.json`. It does not store AWS keys. Role credentials stay in the plugin process, from `aws configure export-credentials`, and are refreshed there before they expire. The profile picker honors `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE`.

Set `MAGPIE_BEDROCK_AWS_CLI` if `aws` is not on Magpie's PATH. On macOS the plugin also checks Homebrew's usual locations.

## Models

Claude inference profiles use Bedrock's Anthropic Messages API. OpenAI GPT inference profiles use chat completions, which the plugin runs on Converse. The catalog is the account's active system-defined Claude and GPT profiles in that region's geography, plus global ones. Magpie's visibility selection still applies. Names look like `bedrock-sso/us.anthropic.claude-opus-5-5` and `bedrock-sso/us.openai.gpt-6.1-terra`.

Limits and prices come from Magpie's local `amazon-bedrock` catalog when present; otherwise limits are estimates and prices are unknown. Cost estimates are not bills.

## Requirements

- Magpie with provider plugin support
- AWS CLI v2 and a profile that can call Bedrock
- Node.js 20+ for offline tests (Magpie runs the plugin on Bun)

Your AWS policies decide which models you can invoke.

## Install from a local checkout

```sh
magpie plugin add /absolute/path/to/magpie-bedrock-sso
magpie plugin login bedrock-sso
magpie provider refresh bedrock-sso
```

The plugin loads from that folder. Keep the directory. `magpie provider bedrock-sso` lists exposed and hidden models; `magpie provider models bedrock-sso +<model-id>` exposes one.

## Requests and limits

The GPT adapter supports text, base64 image data URLs, function tools, tool results, streaming, and supported reasoning efforts. It rejects remote image URLs, image-detail controls, malformed tool arguments, named participants, audio, structured output, strict function schemas, web search, prediction, and disabling parallel tool calls. System and developer instructions must precede the conversation. Tool history needs tool definitions. Unsupported controls that it recognizes error. Storage-only fields (`store`, `metadata`, `user`) are not forwarded. Encrypted Bedrock reasoning may not replay. The event-stream decoder checks frame bounds and CRC32; a 32 MiB frame cap is a client limit.

## Test

```sh
npm test
AWS_PROFILE=<profile> node test/live.mjs
MAGPIE_TEST_URL=http://127.0.0.1:3499 node test/gateway-live.mjs
```

Live tests send billable Bedrock prompts. `gateway-live.mjs` needs an isolated Magpie with this plugin signed in.

## Release status

Do not publish to npm or add the `magpie-plugin` GitHub topic until distribution permission is settled. Confirm license, review credential handling, and test Magpie versions first.
