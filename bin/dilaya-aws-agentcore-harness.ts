import * as cdk from "aws-cdk-lib";
import { AgentcoreHarnessStack } from "../lib/agentcore-harness-stack.ts";

const app = new cdk.App();
new AgentcoreHarnessStack(app, process.env.STACK_NAME ?? "dilaya-aws-agentcore-harness-dev", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
