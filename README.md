# Bedrock SSO plugin for Magpie

Use an AWS CLI profile with Amazon Bedrock in Magpie. The plugin signs requests with AWS Signature Version 4. It does not require a Bedrock bearer API key.

This is a candidate release, not a published or audited package. The plugin supports Claude and OpenAI GPT inference profiles. It does not yet support every model in the Bedrock catalog. The repository is private while distribution permission is unresolved.

## Requirements

- Magpie with OpenCode provider plugin support.
- AWS CLI v2 and an AWS profile with access to Bedrock.
- Node.js 20 or later to run the offline tests. Magpie runs the plugin in its Bun host.

Your organization's AWS policies decide which models and regions you can invoke. The ability to list a model does not imply permission to use it.

## Install from a local checkout

```sh
magpie plugin add /absolute/path/to/magpie-bedrock-sso
magpie plugin login bedrock-sso
magpie provider refresh bedrock-sso
```

Select your AWS profile and a Bedrock region. The AWS CLI opens a browser if its SSO session has expired. Models use names such as `bedrock-sso/us.anthropic.claude-opus-5-5` and `bedrock-sso/us.openai.gpt-6.1-terra`. Magpie can hide models in its provider selection. Run `magpie provider bedrock-sso` to see exposed and hidden models. Use `magpie provider models bedrock-sso +<model-id>` to expose one.

The code is loaded from the installed checkout. Keep that directory in place. Releases are maintained in the repository. There is no published npm package yet.

## Authentication

The plugin uses `aws configure export-credentials` with the chosen profile. The AWS CLI reads its own configuration and SSO cache. The plugin caches the exported role credentials in memory and refreshes them before they expire. Magpie stores the profile name, region, and account label, not AWS keys.

When the SSO session expires, sign in again in Magpie or run:

```sh
aws sso login --profile <profile>
```

Set `MAGPIE_BEDROCK_AWS_CLI` to the AWS CLI executable if it is not on the Magpie process's PATH. On macOS, the plugin also checks Homebrew's usual locations.

## Requests and limits

Claude requests use Bedrock's Anthropic Messages endpoint. GPT requests use Bedrock Converse. Magpie sends GPT requests to the plugin as OpenAI Chat Completions, and the plugin translates them to Converse and back. AWS request signing always uses HTTPS. The plugin rejects untrusted hosts, nonstandard ports, unsupported paths, and redirects.

The GPT adapter supports text, base64 image data URLs, function tools, tool results, streaming, and supported reasoning efforts. It rejects remote image URLs, malformed tool arguments, named message participants, audio output, structured-output requests, strict function schemas, and disabling parallel tool calls. It rejects `tool_choice: none` when the conversation contains tool history because Converse requires tool definitions for that history. Unsupported requests receive an error rather than a modified prompt. The adapter does not support every OpenAI Chat Completions field. Use it only with agents whose requests you have tested.

Bedrock may return encrypted reasoning that the adapter cannot replay or display. Test your agent's multi-turn reasoning before relying on it. Bedrock model capabilities, tool choices, and allowed reasoning levels can differ by model.

The event-stream decoder checks frame bounds, CRC32 checksums, and message completion. A 32 MiB maximum frame is a client safety limit. It may reject a valid larger AWS event frame.

## Model list and cost metadata

The plugin lists active system-defined inference profiles in the configured geography and global profiles, then filters to Claude and OpenAI GPT. It does not list standalone foundation models, application profiles, or models from other vendors. Magpie applies a separate visibility selection on top of this catalog.

When available, the plugin reads Magpie's local `amazon-bedrock` model catalog for exact model limits and base prices. The catalog may be stale, omit a model, or omit region- and tier-specific pricing. When it is absent, model limits fall back to estimates and prices are unknown. Cost estimates are not billing records. Pricing for long-context tiers is not represented by this plugin.

## Test

```sh
npm test
AWS_PROFILE=<profile> node test/live.mjs
MAGPIE_TEST_URL=http://127.0.0.1:3499 node test/gateway-live.mjs
```

The live tests send billable prompts to Bedrock. `gateway-live.mjs` expects an isolated Magpie instance with this plugin installed and signed in. It exercises model discovery, GPT tool use, a streamed tool-result turn, and a Claude request.

## Release status

Before public distribution, confirm permission to distribute the code and license, review dependencies and credential handling, run the included CI workflow, and test supported platforms and Magpie versions. Do not publish organization-specific account identifiers or internal endpoints in examples. An npm release and a Magpie community listing are separate release steps.
