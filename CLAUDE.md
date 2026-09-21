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
  - `iamPolicyAgentcoreControl` — `CreateHarness` / `Get` / `Update` / `DeleteHarness`, **the
    actions a harness spends on what it is made of** (below), `iam:PassRole` on the execution role
    to AgentCore alone, and `logs:CreateLogGroup` + `PutRetentionPolicy` on
    `/aws/bedrock-agentcore/runtimes/*`;
  - `iamPolicyAgentcoreInvoke` — `InvokeHarness` **and `InvokeAgentRuntime`**, plus an explicit
    **Deny** on `InvokeAgentRuntimeCommand` (a shell in the runtime).

**The fence is the tag `dilaya:cloud-agent=1`** — the request tag where a resource is being created,
the resource tag elsewhere. A harness created by hand in the same account is out of the connector's
reach. The connector MUST pass that tag at creation (output `agentcoreHarnessTag`); the harness hands
it down to the runtime and the identity it creates. Three grants cannot be held by a tag, and say so
in `policies.ts`: `GetAgentRuntime` and `DeleteWorkloadIdentity` are fenced by NAME
(`harness_dilaya_*` — the connector names every harness `dilaya_…`), and `DeleteAgentRuntime`
carries `StringEqualsIfExists` (an UNTAGGED runtime passes — the weak point, and the only form
AgentCore accepts).

## A harness is several resources (trial stack, 21/09/2026)

AgentCore builds a harness's runtime, the runtime's endpoint and its workload identity **with the
caller's own credentials**. None of it is documented, and 0.1.0 — whose action names had all been
checked against the service reference — could not create a single harness. Read off real refusals,
one at a time, under these exact documents:

| Call | Also needs | Authorized on |
| --- | --- | --- |
| `CreateHarness` | `CreateAgentRuntime` | literal `runtime/*`, request tag |
| | `CreateAgentRuntimeEndpoint` | literal `runtime/*`, resource tag |
| | `CreateWorkloadIdentity` | the directory AND `…/workload-identity/*`, request tag |
| | `GetAgentRuntime` | the runtime's own ARN |
| `InvokeHarness` | `InvokeAgentRuntime` | the **harness** ARN (not the runtime's) |
| `DeleteHarness` | `DeleteAgentRuntimeEndpoint` | the runtime's ARN, resource tag |
| | `DeleteAgentRuntime` | literal `runtime/*` first — no resource, so no tag |
| | `DeleteWorkloadIdentity` | the directory (+ the identity) |
| | `GetAgentRuntime` **after the runtime is gone** | its ARN — no tag left to read |

The last line is the subtle one: under a tag condition the final read is refused and the harness
ends `DELETE_FAILED` with its runtime already deleted. A missing grant on the create path shows as
`CREATE_FAILED` + `failureReason` on `GetHarness`, never as an error of `CreateHarness` itself
(which answers `CREATING`). Measured with the fixed documents: READY in ~13 s, first invoke ~38 s
(cold runtime), delete ~13 s. The probe is the connector's `scripts/harness-iam-probe.mts` — re-run
it against a throwaway stack of this package before touching these documents.

Not covered: `DeleteHarness` leaves the runtime's **log group** behind (retention empties it, the
group stays). The connector has no `logs:DeleteLogGroup` here.

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

⚠️ `cdk synth` green is not the API contract: IAM accepts an action name that does not exist, and
a correct name says nothing of the DEPENDENT actions a call spends — see the table above, found only
by real calls under these exact documents.

## Conventions

No `Co-Authored-By` trailer. Branch → PR → green → squash.
