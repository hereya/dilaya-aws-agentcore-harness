# dilaya/aws-agentcore-harness

What a Dilaya **cloud agent** needs from the AWS account — and nothing that depends on a
particular agent. CDK package, published to the Hereya registry as
**`dilaya/aws-agentcore-harness`**, consumed by `dilaya-connector`'s `hereya.yaml`.

## Model (read first)

A cloud agent is **one Bedrock AgentCore harness per agent**: the connector creates it at
`set-agent({ type: "cloud" })` and deletes it at `delete-agent` (an agent belongs to one app of
one org and is never shared — Jonatan, 21/09/2026). **This stack therefore holds no harness.** It
holds:

- the single **execution role** every harness runs as (`lib/stack/policies.ts executionPolicy`):
  call the declared models through the `eu.` inference profile, write its logs/traces, fetch its
  own workload token. **Nothing of Dilaya's** — a harness reaches Dilaya through `/mcp` with its
  agent token, like any other client;
- two IAM documents handed to the connector's Lambda role through `iamPolicy*` outputs (the deploy
  package attaches any output with that prefix):
  - `iamPolicyAgentcoreControl` — `CreateHarness` / `Get` / `Update` / `DeleteHarness`,
    `iam:PassRole` on the execution role to AgentCore alone, and `logs:CreateLogGroup` +
    `PutRetentionPolicy` on `/aws/bedrock-agentcore/runtimes/*`;
  - `iamPolicyAgentcoreInvoke` — `InvokeHarness`, plus an explicit **Deny** on
    `InvokeAgentRuntimeCommand` (a shell in the runtime).

**Every grant is pinned on the tag `dilaya:cloud-agent=1`** — the request tag for `CreateHarness`
(no resource exists yet), the resource tag for everything else. A harness created by hand in the
same account is out of the connector's reach. The connector MUST pass that tag at creation
(output `agentcoreHarnessTag`).

## Outputs (consumer env contract)

`agentcoreExecutionRoleArn`, `agentcoreRegion`, `agentcoreModelIds` (the full profile ids, e.g.
`eu.anthropic.claude-haiku-4-5-…`), `agentcoreLogRetentionDays`, `agentcoreHarnessTag`,
`iamPolicyAgentcoreControl`, `iamPolicyAgentcoreInvoke`. CloudFormation output ids are
alphanumeric — no underscores (a test holds that).

## Found in the POC (21/09/2026) — why things are the way they are

- AgentCore creates a runtime's log group **with no retention**, and prompts and tool payloads
  travel through it → the connector creates the group first, with `logRetentionDays`.
- A harness creates a real agent runtime (`harness_<name>-…`) → it counts in the account's quota
  of 1 000.
- A model needs its **Marketplace agreement** before first use: an admin invokes it once in the
  Bedrock playground. Adding a model id here does not do that.
- `allowedTools: ["@<server>"]` at invoke time removes the built-in `shell` / `file_operations`
  tools — the runner must always pass it.

## Commands

```bash
npm run typecheck
npm test            # policy documents + a synth assertion
npm run synth
```

CI (`ci.yml`) runs typecheck + tests + the 220-line guard on PRs. **Publish** = a GitHub release
`v<version>` (`publish.yml` runs `hereya publish`; the repo must be on the org secret
`HEREYA_TOKEN`'s selected list). Publishing never deploys: bump the connector's `hereya.yaml` pin
and cut a connector release.

⚠️ `cdk synth` green is not the API contract: IAM accepts an action name that does not exist. The
action names were checked against the AWS service reference
(`servicereference.us-east-1.amazonaws.com/v1/bedrock-agentcore/…`); whether `CreateHarness` needs
further dependent actions is only provable by a real call under this exact policy.

## Conventions

No `Co-Authored-By` trailer. Branch → PR → green → squash.
