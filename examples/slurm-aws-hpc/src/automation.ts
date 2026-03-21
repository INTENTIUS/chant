/**
 * SSM Automation document for post-provision cluster configuration.
 *
 * Why SSM Automation for post-provision steps (not shell script):
 *   - Each step is retried by SSM on transient failures (API throttle, etc.)
 *   - Step output is stored in SSM execution history — easy post-mortem
 *   - Integrates with EventBridge for step-level progress notifications
 *   - No SSH bastion needed — SSM Run Command works over the SSM agent
 *
 * Scope: This document handles everything AFTER CloudFormation stacks are
 * deployed. CloudFormation stacks are deployed by scripts/deploy.sh directly
 * (passing large templates as SSM parameters isn't reliable).
 *
 * Steps:
 *   1. GenerateMungeKey   — creates a 1024-byte random key, stores in SSM SecureString
 *   2. ReconfigureSlurm   — reloads slurm.conf on the head node
 *   3. WaitNodesJoin      — polls sinfo until compute nodes appear (up to 15 min)
 *   4. SetupAccounts      — creates default sacctmgr cluster/account/user
 *
 * Deploy via scripts/deploy.sh (called automatically after CFN stacks are up).
 */

import { Document, SsmParameter } from "@intentius/chant-lexicon-aws";
import { Sub } from "@intentius/chant-lexicon-aws";
import { config } from "./config";

const POST_PROVISION_STEPS = [
  {
    name: "GenerateMungeKey",
    action: "aws:executeScript",
    description: "Generate MUNGE authentication key and store in SSM SecureString",
    onFailure: "Abort",
    inputs: {
      Runtime: "python3.11",
      Handler: "generate_munge_key",
      Script: [
        "import boto3, secrets, base64",
        "def generate_munge_key(events, context):",
        "    ssm = boto3.client('ssm')",
        "    key = base64.b64encode(secrets.token_bytes(1024)).decode()",
        "    ssm.put_parameter(",
        "        Name=f\"/{events['ClusterName']}/munge/key\",",
        "        Value=key, Type='SecureString', Overwrite=True)",
        "    return {'status': 'ok', 'parameter': f\"/{events['ClusterName']}/munge/key\"}",
      ].join("\n"),
      InputPayload: { ClusterName: "{{ ClusterName }}" },
    },
  },
  {
    name: "ReconfigureSlurm",
    action: "aws:runCommand",
    description: "Reload slurm.conf on the head node after initial provisioning",
    onFailure: "Continue",
    inputs: {
      DocumentName: "AWS-RunShellScript",
      Targets: [{ Key: `tag:cluster`, Values: ["{{ ClusterName }}"] },
                { Key: "tag:role", Values: ["head"] }],
      Parameters: { commands: ["scontrol reconfigure || true"] },
      TimeoutSeconds: 30,
    },
  },
  {
    name: "WaitNodesJoin",
    action: "aws:executeScript",
    description: "Poll sinfo until at least one compute node appears (up to 15 min)",
    onFailure: "Continue",
    timeoutSeconds: 900,
    inputs: {
      Runtime: "python3.11",
      Handler: "wait_nodes",
      Script: [
        "import subprocess, time",
        "def wait_nodes(events, context):",
        "    for attempt in range(30):",
        "        try:",
        "            out = subprocess.check_output(['sinfo', '--noheader', '-o', '%T']).decode()",
        "            if 'idle' in out or 'mix' in out:",
        "                return {'status': 'ready', 'attempts': attempt + 1}",
        "        except subprocess.CalledProcessError:",
        "            pass",
        "        time.sleep(30)",
        "    return {'status': 'timeout', 'message': 'No nodes joined in 15 min — check slurmd on compute nodes'}",
      ].join("\n"),
    },
  },
  {
    name: "SetupAccounts",
    action: "aws:runCommand",
    description: "Create default Slurm accounting cluster, account, and admin user",
    onFailure: "Continue",
    inputs: {
      DocumentName: "AWS-RunShellScript",
      Targets: [{ Key: `tag:cluster`, Values: ["{{ ClusterName }}"] },
                { Key: "tag:role", Values: ["head"] }],
      Parameters: {
        commands: [
          "sacctmgr -i add cluster {{ ClusterName }} || true",
          "sacctmgr -i add account default description='default account' organization=hpc || true",
          "sacctmgr -i add user admin account=default adminlevel=admin || true",
        ],
      },
      TimeoutSeconds: 60,
    },
  },
];

export const postProvisionDocument = new Document({
  Name: `${config.clusterName}-post-provision`,
  DocumentType: "Automation",
  DocumentFormat: "JSON",
  Content: {
    schemaVersion: "0.3",
    description: `Post-provision configuration for the ${config.clusterName} EDA HPC cluster`,
    parameters: {
      ClusterName: { type: "String", default: config.clusterName },
    },
    mainSteps: POST_PROVISION_STEPS,
  },
});

// Expose the document name in SSM so scripts/deploy.sh can read it without
// hard-coding the name (useful if clusterName is overridden via env).
export const documentNameParam = new SsmParameter({
  Name: Sub(`/${config.clusterName}/automation/post-provision-document`),
  Type: "String",
  Value: Sub(`${config.clusterName}-post-provision`),
  Description: `SSM Automation document name for ${config.clusterName} post-provision`,
});
