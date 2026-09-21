import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { readParams } from "./stack/params.ts";
import {
  HARNESS_TAG_KEY,
  HARNESS_TAG_VALUE,
  controlPolicy,
  executionPolicy,
  executionTrustPolicy,
  invokePolicy,
  type PolicyInput,
} from "./stack/policies.ts";

// dilaya/aws-agentcore-harness — what a Dilaya CLOUD agent needs from the AWS
// account, and nothing that depends on a particular agent.
//
// A cloud agent is ONE Bedrock AgentCore harness, created by the connector at
// set-agent and deleted at delete-agent (an agent belongs to one app of one org
// and is never shared). So this stack holds no harness: it holds the single
// EXECUTION role every harness runs as, and hands the connector the grants to
// create, run and delete harnesses that carry the Dilaya tag.
export class AgentcoreHarnessStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const params = readParams(process.env);
    const input: PolicyInput = {
      region: this.region,
      account: this.account,
      modelIds: params.modelIds,
      profilePrefix: params.profilePrefix,
    };

    const role = new iam.CfnRole(this, "HarnessExecutionRole", {
      assumeRolePolicyDocument: executionTrustPolicy(input),
      policies: [{ policyName: "harness-execution", policyDocument: executionPolicy(input) }],
      description: "Execution role shared by every Dilaya cloud-agent harness (Bedrock AgentCore).",
    });

    // --- Package outputs (consumer env contract) ---------------------------
    new cdk.CfnOutput(this, "agentcoreExecutionRoleArn", { value: role.attrArn });
    new cdk.CfnOutput(this, "agentcoreRegion", { value: this.region });
    new cdk.CfnOutput(this, "agentcoreModelIds", {
      value: params.modelIds.map((id) => `${params.profilePrefix}.${id}`).join(","),
    });
    new cdk.CfnOutput(this, "agentcoreLogRetentionDays", { value: String(params.logRetentionDays) });
    new cdk.CfnOutput(this, "agentcoreHarnessTag", { value: `${HARNESS_TAG_KEY}=${HARNESS_TAG_VALUE}` });
    new cdk.CfnOutput(this, "iamPolicyAgentcoreControl", {
      value: cdk.Stack.of(this).toJsonString(controlPolicy(input, role.attrArn)),
    });
    new cdk.CfnOutput(this, "iamPolicyAgentcoreInvoke", {
      value: cdk.Stack.of(this).toJsonString(invokePolicy(input)),
    });
  }
}
