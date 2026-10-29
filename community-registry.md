# Community registry listing (paste-ready)

Do not open this until the repo is public and `magpie-aws-bedrock-sso@0.3.0` is on npm. Magpie's market installs the npm package named in the entry.

No PR was opened on [magpie-community/plugins](https://github.com/magpie-community/plugins). `community: true` is required: Magpie's `parseMarket` keeps only entries with that flag.

## Registry entry

```json
{ "package": "magpie-aws-bedrock-sso", "name": "AWS Bedrock SSO", "providers": ["bedrock-sso"], "community": true,
  "summary": { "en": "Amazon Bedrock signed with SigV4 from your AWS CLI profile (SSO / IAM Identity Center). No Bedrock API key.", "zh": "用本机 AWS CLI 配置文件（SSO / IAM Identity Center）以 SigV4 调用 Amazon Bedrock，无需 Bedrock API key。" } }
```

## Patch against `magpie-community/plugins` `registry.json` (tail only)

```diff
diff --git a/registry.json b/registry.json
--- a/registry.json
+++ b/registry.json
@@ -130,6 +130,8 @@
         "en": "Tencent Cloud OrcaTerm (遨驰终端) AI assistant models — DeepSeek, Hunyuan, GLM, Kimi — on the account's monthly question allowance. Unofficial; the README sets out the terms.",
         "zh": "用腾讯云遨驰终端（OrcaTerm）AI 助手的模型——DeepSeek、混元、GLM、Kimi——走账号每月问答额度。非官方，条款风险见 README。"
       }
-    }
+    },
+    { "package": "magpie-aws-bedrock-sso", "name": "AWS Bedrock SSO", "providers": ["bedrock-sso"], "community": true,
+      "summary": { "en": "Amazon Bedrock signed with SigV4 from your AWS CLI profile (SSO / IAM Identity Center). No Bedrock API key.", "zh": "用本机 AWS CLI 配置文件（SSO / IAM Identity Center）以 SigV4 调用 Amazon Bedrock，无需 Bedrock API key。" } }
   ]
 }
```

## Ready-to-paste PR

**Title:** `registry: add magpie-aws-bedrock-sso (AWS Bedrock SSO)`

**Body:**

```
Adds magpie-aws-bedrock-sso to registry.json so Magpie's Plugins tab can suggest Amazon Bedrock signed with an AWS CLI profile (SSO / IAM Identity Center). Provider id: bedrock-sso.

Independently published from https://github.com/HaroldLeo/magpie-bedrock-sso (MIT). Not a @magpie-community package. Install: magpie plugin add magpie-aws-bedrock-sso

This listing only works once that repo is public and the package is on npm.

community: true is required; Magpie's market parser keeps only entries with that flag. Tail-only change.

bun scripts/check.mjs magpie-aws-bedrock-sso: ✓
```
