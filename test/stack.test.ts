import { test } from "node:test";
import assert from "node:assert/strict";
import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { AgentcoreHarnessStack } from "../lib/agentcore-harness-stack.ts";
import { readParams } from "../lib/stack/params.ts";
import { controlPolicy, executionPolicy, invokePolicy, type PolicyInput } from "../lib/stack/policies.ts";

const INPUT: PolicyInput = {
  region: "eu-west-1",
  account: "111122223333",
  modelIds: ["anthropic.claude-haiku-4-5-20251001-v1:0"],
  profilePrefix: "eu",
};
const ROLE = "arn:aws:iam::111122223333:role/exec";

type Stmt = { Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, unknown> };
const statements = (d: { Statement: unknown[] }) => d.Statement as Stmt[];
const actionsOf = (d: { Statement: unknown[] }, effect = "Allow") =>
  statements(d).filter((s) => s.Effect === effect).flatMap((s) => [s.Action].flat());

test("the connector never gets a shell in a runtime — and cannot be handed one elsewhere", () => {
  const all = [...actionsOf(controlPolicy(INPUT, ROLE)), ...actionsOf(invokePolicy(INPUT))];
  assert.ok(!all.includes("bedrock-agentcore:InvokeAgentRuntimeCommand"));
  assert.ok(!all.some((a) => a.includes("*")), `no wildcard action: ${all.join(", ")}`);
  assert.deepEqual(actionsOf(invokePolicy(INPUT), "Deny"), ["bedrock-agentcore:InvokeAgentRuntimeCommand"]);
});

test("every harness grant is pinned on the Dilaya tag", () => {
  for (const s of [...statements(controlPolicy(INPUT, ROLE)), ...statements(invokePolicy(INPUT))]) {
    const acts = [s.Action].flat().filter((a) => a.startsWith("bedrock-agentcore:"));
    if (acts.length === 0 || s.Effect !== "Allow") continue;
    const cond = JSON.stringify(s.Condition ?? {});
    assert.match(cond, /aws:(Request|Resource)Tag\/dilaya:cloud-agent/, `${acts.join(",")} is not tag-pinned`);
  }
});

test("PassRole names the execution role alone, to AgentCore alone", () => {
  const pass = statements(controlPolicy(INPUT, ROLE)).find((s) => s.Action === "iam:PassRole");
  assert.equal(pass?.Resource, ROLE);
  assert.deepEqual(pass?.Condition, { StringEquals: { "iam:PassedToService": "bedrock-agentcore.amazonaws.com" } });
});

test("a harness may call the declared models and nothing of Dilaya's", () => {
  const d = executionPolicy(INPUT);
  const model = statements(d).find((s) => [s.Action].flat().includes("bedrock:InvokeModel"));
  assert.deepEqual(model?.Resource, [
    "arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
    "arn:aws:bedrock:eu-west-1:111122223333:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  ]);
  const services = new Set(actionsOf(d).map((a) => a.split(":")[0]));
  for (const forbidden of ["dynamodb", "s3", "ssm", "secretsmanager", "lambda", "iam"]) {
    assert.ok(!services.has(forbidden), `the execution role must not reach ${forbidden}`);
  }
});

test("parameters refuse what would synth into an unintended grant", () => {
  assert.deepEqual(readParams({}).modelIds, ["anthropic.claude-haiku-4-5-20251001-v1:0"]);
  assert.equal(readParams({}).logRetentionDays, 7);
  assert.throws(() => readParams({ modelIds: "eu.anthropic.claude-haiku-4-5-20251001-v1:0" }), /bare model id/);
  assert.throws(() => readParams({ modelIds: "*" }), /not a foundation-model id/);
  assert.throws(() => readParams({ logRetentionDays: "10" }), /not one of/);
  assert.throws(() => readParams({ inferenceProfilePrefix: "eu.*" }), /not valid/);
});

test("the synthesized stack holds ONE role, no harness, and the consumer outputs", () => {
  const app = new cdk.App();
  const stack = new AgentcoreHarnessStack(app, "T", { env: { account: "111122223333", region: "eu-west-1" } });
  const t = Template.fromStack(stack);
  t.resourceCountIs("AWS::IAM::Role", 1);
  assert.deepEqual(Object.keys(t.toJSON().Resources).length, 1, "nothing but the execution role");
  const outputs = Object.keys(t.toJSON().Outputs).sort();
  assert.deepEqual(outputs, [
    "agentcoreExecutionRoleArn",
    "agentcoreHarnessTag",
    "agentcoreLogRetentionDays",
    "agentcoreModelIds",
    "agentcoreRegion",
    "iamPolicyAgentcoreControl",
    "iamPolicyAgentcoreInvoke",
  ]);
  for (const name of outputs) assert.match(name, /^[A-Za-z0-9]+$/, "CloudFormation output ids are alphanumeric");
});
