// The IAM documents of the package, as PURE functions of (region, account,
// models, role ARN) — so a test reads exactly what ships, without a synth.
//
// Two principals, two different jobs:
//   - the EXECUTION role is what a harness runs as (assumed by AgentCore);
//   - the CONTROL / INVOKE documents are attached to the connector's Lambda role
//     through the `iamPolicy*` outputs (the deploy package attaches any output
//     with that prefix).
//
// Every harness Dilaya creates carries the tag HARNESS_TAG. CreateHarness has no
// resource to scope (it does not exist yet), so it is pinned on the REQUEST tag;
// everything else is pinned on the RESOURCE tag. A harness somebody created by
// hand in the same account is therefore out of the connector's reach.

export const HARNESS_TAG_KEY = "dilaya:cloud-agent";
export const HARNESS_TAG_VALUE = "1";

/** Where AgentCore writes a runtime's logs — and the prompts and tool payloads
 *  travel through there, hence the short retention the connector sets on it. */
export const RUNTIME_LOG_GROUP_PREFIX = "/aws/bedrock-agentcore/runtimes/";

export interface PolicyInput {
  region: string;
  account: string;
  /** Bare foundation-model ids, e.g. "anthropic.claude-haiku-4-5-20251001-v1:0". */
  modelIds: string[];
  /** Cross-region inference profile prefix ("eu" keeps inference in the EU). */
  profilePrefix: string;
}

type Statement = Record<string, unknown>;
const doc = (Statement: Statement[]) => ({ Version: "2012-10-17", Statement });

const logGroupArn = (i: PolicyInput) =>
  `arn:aws:logs:${i.region}:${i.account}:log-group:${RUNTIME_LOG_GROUP_PREFIX}*`;
const agentcoreArn = (i: PolicyInput, rest: string) => `arn:aws:bedrock-agentcore:${i.region}:${i.account}:${rest}`;
const harnessArn = (i: PolicyInput) => agentcoreArn(i, "harness/*");
const runtimeArn = (i: PolicyInput) => agentcoreArn(i, "runtime/*");
const WORKLOAD_DIRECTORY = "workload-identity-directory/default";

/** Trust policy of the execution role: AgentCore of THIS account and region only. */
export function executionTrustPolicy(i: PolicyInput) {
  return doc([
    {
      Effect: "Allow",
      Principal: { Service: "bedrock-agentcore.amazonaws.com" },
      Action: "sts:AssumeRole",
      Condition: {
        StringEquals: { "aws:SourceAccount": i.account },
        ArnLike: { "aws:SourceArn": `arn:aws:bedrock-agentcore:${i.region}:${i.account}:*` },
      },
    },
  ]);
}

/** What a running harness may do: call its models, write its logs and traces,
 *  and fetch its own workload token. Nothing of Dilaya's — the harness reaches
 *  Dilaya through /mcp with the agent token, like any other client. */
export function executionPolicy(i: PolicyInput) {
  const models = i.modelIds.flatMap((id) => [
    // A cross-region profile fans out to the foundation model in ANY region of
    // its geography, so the model ARN keeps a region wildcard on purpose.
    `arn:aws:bedrock:*::foundation-model/${id}`,
    `arn:aws:bedrock:${i.region}:${i.account}:inference-profile/${i.profilePrefix}.${id}`,
  ]);
  const directory = `arn:aws:bedrock-agentcore:${i.region}:${i.account}:workload-identity-directory/default`;
  return doc([
    { Effect: "Allow", Action: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], Resource: models },
    { Effect: "Allow", Action: ["ecr-public:GetAuthorizationToken", "sts:GetServiceBearerToken"], Resource: "*" },
    {
      Effect: "Allow",
      Action: ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"],
      Resource: "*",
    },
    {
      Effect: "Allow",
      Action: ["logs:CreateLogGroup", "logs:DescribeLogStreams", "logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: logGroupArn(i),
    },
    { Effect: "Allow", Action: "logs:DescribeLogGroups", Resource: "*" },
    {
      Effect: "Allow",
      Action: "cloudwatch:PutMetricData",
      Resource: "*",
      Condition: { StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" } },
    },
    {
      Effect: "Allow",
      Action: ["bedrock-agentcore:GetWorkloadAccessToken", "bedrock-agentcore:GetWorkloadAccessTokenForJWT"],
      Resource: [directory, `${directory}/workload-identity/harness_*`],
    },
  ]);
}

/** Connector side, control plane: one harness per agent — created at set-agent,
 *  deleted at delete-agent — and the retention of the log group it brings.
 *
 *  A harness is NOT one resource: AgentCore builds its runtime, the runtime's
 *  endpoint and its workload identity WITH THE CALLER'S OWN credentials, so the
 *  caller needs those actions too. None of it is documented: each grant below is a
 *  refusal read off a real CreateHarness / DeleteHarness under this exact document
 *  (trial stack, 21/09/2026 — the connector's scripts/harness-iam-probe.mts). The
 *  harness hands its tags down to what it creates, so the tag fence holds there too. */
export function controlPolicy(i: PolicyInput, executionRoleArn: string) {
  const tagged = { StringEquals: { [`aws:ResourceTag/${HARNESS_TAG_KEY}`]: HARNESS_TAG_VALUE } };
  const requestTagged = { StringEquals: { [`aws:RequestTag/${HARNESS_TAG_KEY}`]: HARNESS_TAG_VALUE } };
  const identities = `${WORKLOAD_DIRECTORY}/workload-identity/`;
  return doc([
    {
      Effect: "Allow",
      Action: ["bedrock-agentcore:CreateHarness", "bedrock-agentcore:TagResource"],
      Resource: "*",
      Condition: requestTagged,
    },
    {
      Effect: "Allow",
      Action: ["bedrock-agentcore:CreateAgentRuntime", "bedrock-agentcore:CreateWorkloadIdentity"],
      // CreateWorkloadIdentity is authorized on the directory AND on the identity.
      Resource: [runtimeArn(i), agentcoreArn(i, WORKLOAD_DIRECTORY), agentcoreArn(i, `${identities}*`)],
      Condition: requestTagged,
    },
    {
      Effect: "Allow",
      Action: ["bedrock-agentcore:CreateAgentRuntimeEndpoint", "bedrock-agentcore:DeleteAgentRuntimeEndpoint"],
      Resource: runtimeArn(i),
      Condition: tagged,
    },
    {
      // Fenced by NAME, not by tag: DeleteHarness keeps reading the runtime until it
      // is GONE, and a runtime that no longer exists has no tag — under a tag
      // condition that last read is refused and the harness ends DELETE_FAILED
      // (measured). A harness's runtime is "harness_<harness name>-…".
      Effect: "Allow",
      Action: "bedrock-agentcore:GetAgentRuntime",
      Resource: agentcoreArn(i, "runtime/harness_dilaya_*"),
    },
    {
      // AgentCore authorizes this one against the literal "runtime/*" BEFORE it
      // names a runtime: no resource, so no tag to read, and a plain StringEquals
      // refuses every deletion (measured). IfExists lets that first check through
      // and still refuses a runtime tagged otherwise. Weaker than the rest of the
      // fence — an UNTAGGED runtime passes — and the only form that works.
      Effect: "Allow",
      Action: "bedrock-agentcore:DeleteAgentRuntime",
      Resource: runtimeArn(i),
      Condition: { StringEqualsIfExists: { [`aws:ResourceTag/${HARNESS_TAG_KEY}`]: HARNESS_TAG_VALUE } },
    },
    {
      // No tag reaches this call: fenced by NAME — a harness's identity is
      // "harness_<harness name>-…" and the connector names every harness "dilaya_…".
      Effect: "Allow",
      Action: "bedrock-agentcore:DeleteWorkloadIdentity",
      Resource: [agentcoreArn(i, WORKLOAD_DIRECTORY), agentcoreArn(i, `${identities}harness_dilaya_*`)],
    },
    {
      Effect: "Allow",
      Action: ["bedrock-agentcore:GetHarness", "bedrock-agentcore:UpdateHarness", "bedrock-agentcore:DeleteHarness"],
      Resource: harnessArn(i),
      Condition: tagged,
    },
    {
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: executionRoleArn,
      Condition: { StringEquals: { "iam:PassedToService": "bedrock-agentcore.amazonaws.com" } },
    },
    // AgentCore creates the runtime's log group WITHOUT a retention (measured in
    // the POC): the connector creates it first, with one.
    { Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:PutRetentionPolicy"], Resource: logGroupArn(i) },
  ]);
}

/** Connector side, data plane: run a Dilaya harness. InvokeAgentRuntimeCommand
 *  (a shell in the runtime) is deliberately absent — and explicitly denied, so a
 *  broader grant added elsewhere on the role cannot bring it back. */
export function invokePolicy(i: PolicyInput) {
  return doc([
    {
      Effect: "Allow",
      // InvokeHarness ALONE is refused: AgentCore also checks InvokeAgentRuntime —
      // on the HARNESS arn, not the runtime's (measured, same trial).
      Action: ["bedrock-agentcore:InvokeHarness", "bedrock-agentcore:InvokeAgentRuntime"],
      Resource: [harnessArn(i), `${harnessArn(i)}/harness-endpoint/*`],
      Condition: { StringEquals: { [`aws:ResourceTag/${HARNESS_TAG_KEY}`]: HARNESS_TAG_VALUE } },
    },
    { Effect: "Deny", Action: "bedrock-agentcore:InvokeAgentRuntimeCommand", Resource: "*" },
  ]);
}
