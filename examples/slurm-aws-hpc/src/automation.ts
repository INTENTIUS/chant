/**
 * SSM Automation document for orchestrated cluster deployment.
 *
 * Why SSM Automation instead of a script:
 *   - AWS-native durable orchestration — no extra runtime dependencies
 *   - Each step is retried by SSM on transient failures (API throttle, etc.)
 *   - Integrates with EventBridge for progress notifications
 *   - Step output is stored in SSM execution history — easy post-mortem
 *
 * Deploy via scripts/deploy.sh:
 *   aws ssm start-automation-execution \
 *     --document-name EdaHpcBootstrap \
 *     --parameters ClusterName=eda-hpc,...
 */

import { Document, SsmParameter } from "@intentius/chant-lexicon-aws";
import { Sub } from "@intentius/chant-lexicon-aws";
import { config } from "./config";

// The automation document content (see ssm/bootstrap.yaml for the full YAML source)
const AUTOMATION_STEPS = [
  {
    name: "DeployNetworking",
    action: "aws:executeAwsApi",
    inputs: {
      Service: "cloudformation",
      Api: "CreateStack",
      StackName: Sub(`${config.clusterName}-networking`),
      TemplateBody: "{{TemplateBody}}",
    },
  },
  {
    name: "WaitNetworking",
    action: "aws:waitForAwsResourceProperty",
    inputs: {
      Service: "cloudformation",
      Api: "DescribeStacks",
      StackName: Sub(`${config.clusterName}-networking`),
      PropertySelector: "$.Stacks[0].StackStatus",
      DesiredValues: ["CREATE_COMPLETE"],
    },
    timeoutSeconds: 300,
  },
  {
    name: "DeployStorage",
    action: "aws:executeAwsApi",
    inputs: {
      Service: "cloudformation",
      Api: "CreateStack",
      StackName: Sub(`${config.clusterName}-storage`),
      TemplateBody: "{{TemplateBody}}",
    },
    // FSx PERSISTENT_2 takes 8–15 minutes to provision
    timeoutSeconds: 1200,
  },
  {
    name: "DeployDatabase",
    action: "aws:executeAwsApi",
    inputs: {
      Service: "cloudformation",
      Api: "CreateStack",
      StackName: Sub(`${config.clusterName}-database`),
      TemplateBody: "{{TemplateBody}}",
    },
    timeoutSeconds: 600,
  },
  {
    name: "DeployCompute",
    action: "aws:executeAwsApi",
    inputs: {
      Service: "cloudformation",
      Api: "CreateStack",
      StackName: Sub(`${config.clusterName}-compute`),
      TemplateBody: "{{TemplateBody}}",
    },
    timeoutSeconds: 300,
  },
  {
    name: "WaitHeadNodeReady",
    action: "aws:waitForAwsResourceProperty",
    inputs: {
      Service: "cloudformation",
      Api: "DescribeStacks",
      StackName: Sub(`${config.clusterName}-compute`),
      PropertySelector: "$.Stacks[0].StackStatus",
      DesiredValues: ["CREATE_COMPLETE"],
    },
    timeoutSeconds: 600,
  },
  {
    name: "ReconfigureSlurm",
    action: "aws:runCommand",
    inputs: {
      DocumentName: "AWS-RunShellScript",
      Targets: [{ Key: "tag:role", Values: ["head"] }],
      Parameters: { commands: ["scontrol reconfigure"] },
    },
  },
  {
    name: "WaitNodesJoin",
    action: "aws:executeScript",
    inputs: {
      Runtime: "python3.11",
      Handler: "wait_nodes",
      Script: [
        "import boto3, subprocess, time",
        "def wait_nodes(events, context):",
        "  for _ in range(30):",
        "    out = subprocess.check_output(['sinfo', '--noheader', '-o', '%T']).decode()",
        "    if 'idle' in out or 'mix' in out: return {'status': 'ready'}",
        "    time.sleep(30)",
        "  raise Exception('Nodes did not join within 15 minutes')",
      ].join("\n"),
    },
  },
  {
    name: "SetupAccounts",
    action: "aws:runCommand",
    inputs: {
      DocumentName: "AWS-RunShellScript",
      Targets: [{ Key: "tag:role", Values: ["head"] }],
      Parameters: {
        commands: [
          `sacctmgr -i add cluster ${config.clusterName}`,
          "sacctmgr -i add account default description='default account' organization=hpc",
          "sacctmgr -i add user $(whoami) account=default adminlevel=admin",
        ],
      },
    },
  },
];

export const bootstrapDocument = new Document({
  Name: "EdaHpcBootstrap",
  DocumentType: "Automation",
  DocumentFormat: "JSON",
  Content: {
    schemaVersion: "0.3",
    description: `Bootstrap the ${config.clusterName} EDA HPC cluster`,
    parameters: {
      ClusterName: { type: "String", default: config.clusterName },
    },
    mainSteps: AUTOMATION_STEPS,
  },
});

// Store the document name in SSM for scripts/deploy.sh
export const documentNameParam = new SsmParameter({
  Name: Sub(`/${config.clusterName}/automation/bootstrap-document`),
  Type: "String",
  Value: "EdaHpcBootstrap",
  Description: `SSM Automation document name for ${config.clusterName} bootstrap`,
});
