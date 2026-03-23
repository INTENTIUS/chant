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
import { Sub, Ref } from "@intentius/chant-lexicon-aws";
import { config } from "./config";

const POST_PROVISION_STEPS = [
  {
    name: "GenerateMungeKey",
    action: "aws:runCommand",
    // Runs on the head node EC2 (instance profile already has ssm:GetParameter/PutParameter
    // on the cluster path). Skips if the key already exists — head node may have
    // self-generated it during bootstrap.
    description: "Generate MUNGE authentication key and store in SSM SecureString (skips if key already present)",
    onFailure: "Abort",
    inputs: {
      DocumentName: "AWS-RunShellScript",
      Targets: [{ Key: "tag:cluster", Values: ["{{ ClusterName }}"] },
                { Key: "tag:role", Values: ["head"] }],
      Parameters: {
        commands: [
          "CLUSTER_NAME={{ ClusterName }}",
          "REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)",
          "PARAM_NAME=/$CLUSTER_NAME/munge/key",
          "if aws ssm get-parameter --name \"$PARAM_NAME\" --region \"$REGION\" --query Parameter.Value --output text &>/dev/null; then",
          "  echo 'Munge key already set — skipping generation'",
          "  exit 0",
          "fi",
          "KEY=$(dd if=/dev/urandom bs=1024 count=1 2>/dev/null | base64 -w 0)",
          "aws ssm put-parameter --name \"$PARAM_NAME\" --value \"$KEY\" --type SecureString --overwrite --region \"$REGION\"",
          "echo \"Munge key stored at $PARAM_NAME\"",
        ],
      },
      TimeoutSeconds: 60,
    },
  },
  {
    name: "GenerateJwtKey",
    action: "aws:runCommand",
    description: "Generate JWT signing key for slurmrestd and store in SSM SecureString",
    onFailure: "Continue",
    inputs: {
      DocumentName: "AWS-RunShellScript",
      Targets: [{ Key: "tag:cluster", Values: ["{{ ClusterName }}"] },
                { Key: "tag:role", Values: ["head"] }],
      Parameters: {
        commands: [
          "REGION=$(curl -s http://169.254.169.254/latest/meta-data/placement/region)",
          "openssl rand -base64 32 > /etc/slurm/jwt_hs256.key",
          "chmod 600 /etc/slurm/jwt_hs256.key",
          "chown slurm:slurm /etc/slurm/jwt_hs256.key",
          "aws ssm put-parameter --name /{{ ClusterName }}/slurm/jwt-key " +
          "--value \"$(cat /etc/slurm/jwt_hs256.key)\" --type SecureString --overwrite --region \"$REGION\"",
        ],
      },
      TimeoutSeconds: 30,
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
    name: "StartSlurmrestd",
    action: "aws:runCommand",
    description: "Enable and start slurmrestd REST API daemon on head node",
    onFailure: "Continue",
    inputs: {
      DocumentName: "AWS-RunShellScript",
      Targets: [{ Key: "tag:cluster", Values: ["{{ ClusterName }}"] },
                { Key: "tag:role", Values: ["head"] }],
      Parameters: {
        commands: [
          "systemctl enable --now slurmrestd",
          "sleep 2 && curl -sf http://localhost:6820/slurm/v0.0.38/ping | jq .meta.Slurm.version || true",
        ],
      },
      TimeoutSeconds: 30,
    },
  },
  {
    name: "WaitNodesJoin",
    action: "aws:runCommand",
    // Note: CLOUD nodes show as 'idle~' in sinfo (powered-down idle) immediately after
    // slurmctld starts — they don't become 'idle' until a job triggers resume.
    // This step succeeds as soon as any node is registered (idle~ counts), and exits 0
    // on timeout too — a timeout here is expected and is not a failure.
    description: "Wait for compute nodes to appear in sinfo (CLOUD nodes show as idle~ on registration)",
    onFailure: "Continue",
    inputs: {
      DocumentName: "AWS-RunShellScript",
      Targets: [{ Key: "tag:cluster", Values: ["{{ ClusterName }}"] },
                { Key: "tag:role", Values: ["head"] }],
      Parameters: {
        commands: [
          "for i in $(seq 1 30); do",
          "  if sinfo --noheader -o '%T' 2>/dev/null | grep -qE '^idle'; then",
          "    echo \"Nodes registered after $i attempts: $(sinfo -o '%N %T' --noheader 2>/dev/null)\"",
          "    exit 0",
          "  fi",
          "  echo \"Attempt $i/30: waiting for nodes to appear in sinfo...\"",
          "  sleep 30",
          "done",
          "echo 'No nodes in idle/idle~ state after 15 min — CLOUD nodes will join when a job is submitted (expected)'",
          "exit 0",
        ],
      },
      TimeoutSeconds: 960,
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
  // No custom Name — allows CFN to replace the document freely when content changes.
  // The actual name (auto-generated) is stored in the SSM parameter below.
  DocumentType: "Automation",
  DocumentFormat: "JSON",
  Content: {
    schemaVersion: "0.3",
    description: Sub("Post-provision configuration for the \${AWS::StackName} EDA HPC cluster"),
    parameters: {
      ClusterName: { type: "String", default: Sub("\${AWS::StackName}") },
    },
    mainSteps: POST_PROVISION_STEPS,
  },
});

// Expose the document name in SSM so scripts/deploy.sh can read it without
// hard-coding the name (useful if clusterName is overridden via env).
export const documentNameParam = new SsmParameter({
  Name: Sub("\/${AWS::StackName}/automation/post-provision-document"),
  Type: "String",
  Value: Ref(postProvisionDocument),
  Description: Sub("SSM Automation document name for \${AWS::StackName} post-provision"),
});
