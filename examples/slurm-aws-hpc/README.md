# Slurm EDA HPC Cluster on AWS

A production EDA HPC cluster running Slurm 23.11 on AWS: FSx for Lustre scratch storage, Aurora MySQL for job accounting, EFA-enabled spot GPU fleet, and EventBridge-driven spot interruption handling.

This example uses two chant lexicons together: `@intentius/chant-lexicon-aws` for the cloud infrastructure and `@intentius/chant-lexicon-slurm` for the Slurm configuration. The same `src/` tree produces both a CloudFormation template (`dist/infra.json`) and a ready-to-distribute `dist/slurm.conf`.

## Architecture

```
                          ┌──────────────────────────────────────────────┐
                          │  VPC 10.0.0.0/16  (us-east-1)               │
                          │                                              │
  ┌──────────────┐        │  ┌─────────────┐    ┌─────────────────────┐ │
  │  Aurora MySQL│◄───────┼──┤  Head node  │    │  EFA Placement Grp  │ │
  │  Serverless  │ :3306  │  │  c5.2xlarge │    │                     │ │
  │  (slurmdbd)  │        │  │  slurmctld  │    │  p4d.24xlarge (GPU) │ │
  └──────────────┘        │  │  slurmdbd   │    │  p3.16xlarge (spot) │ │
                          │  └──────┬──────┘    └──────────┬──────────┘ │
  ┌──────────────┐        │         │ :6817-6820            │            │
  │  FSx Lustre  │◄───────┼─────────┴───────────┐ :6818    │            │
  │  PERSISTENT_2│ :988   │                     │          │            │
  │  1200 GiB    │        │     CPU nodes        │ GPU nodes│            │
  │  /scratch    │◄───────┼──   c5.9xlarge   ◄──┘          │            │
  └──────────────┘        │     cpu[001-032]    gpu[001-016]│            │
                          │                                              │
                          └──────────────────────────────────────────────┘
                                        │
                          EventBridge: EC2 Spot Interruption Warning
                                        │
                                        ▼
                                  Lambda (drain + requeue in <30s)
                                  SSM Automation (post-provision config)
```

**Partitions:**
| Partition | Nodes | MaxTime | Use case |
|---|---|---|---|
| `synthesis` (default) | cpu[001-016] | 48h | RTL synthesis, place-and-route |
| `sim` | cpu[017-032] | 7d | Gate-level simulation, formal verification |
| `gpu_eda` | gpu[001-016] | 24h | AI-driven EDA tools, multi-node ML training |

**EDA licenses tracked by Slurm** (jobs request via `--licenses=eda_synth:1`):
- `eda_synth`: 50 tokens
- `eda_sim`: 200 tokens
- `calibre_drc`: 30 tokens

## Agent walkthrough

The Slurm lexicon ships an AI skill (`slurm-generate-cluster`) that understands HPC cluster patterns. After `npm install`, kick off deployment with:

```
Deploy the slurm-aws-hpc example.
My AWS region is us-east-1. My cluster name is eda-hpc.
```

The agent builds the stacks, deploys them, and runs the post-provision automation. The phase breakdown below shows what happens under the hood.

## Prerequisites

- AWS CLI ≥ 2.x configured with credentials (`aws sts get-caller-identity` works)
- Bun ≥ 1.x or Node.js ≥ 20.x
- `jq` (used by deploy scripts)
- An AWS account with service limits for p4d.24xlarge (request via Service Quotas if needed)

```bash
npm install
cp .env.example .env
# Edit .env: set AWS_REGION and CLUSTER_NAME
npm run bootstrap
```

> `src/config.ts` reads `CLUSTER_NAME` and `AWS_REGION` from the environment, so `.env` is the single source of truth for both the scripts and the CloudFormation template.

`npm run bootstrap` checks all prerequisites before you deploy: AWS CLI version, credentials, p4d.24xlarge vCPU quota, and that your `.env` file is present. Fix any `[FAIL]` lines before proceeding. `[WARN]` lines (e.g. quota below target) are non-blocking.

## Project structure

```
src/
  config.ts          — cluster name, region, instance types, CIDR blocks
  networking.ts      → VPC, subnets, NAT Gateway, route tables, security groups
  head-node.ts       → EC2 instance (c5.2xlarge) with UserData bootstrap script
  compute.ts         → GPU ASG launch template + Auto Scaling Group
  storage.ts         → FSx Lustre PERSISTENT_2 filesystem
  database.ts        → Aurora MySQL Serverless v2 (slurmdbd backend)
  iam.ts             → IAM roles and instance profiles (head node + compute)
  security.ts        → Security group rules
  monitoring.ts      → CloudWatch alarms
  events.ts          → EventBridge rule + Lambda for spot interruption
  automation.ts      → SSM Automation document (post-provision steps)
  slurm-cluster.ts   → Slurm lexicon entry point

dist/
  infra.json         — CloudFormation template (all AWS resources above)
  slurm.conf         — Slurm configuration file (distributed to head node by deploy.sh)

scripts/
  bootstrap.sh       — prerequisite checks (run before deploy)
  deploy.sh          — deploys CFN stack, then copies dist/slurm.conf to the head node
  e2e-test.sh        — post-deploy validation (stack, head node, FSx, Aurora, munge, test job)
  slurm_resume_node.sh  — ResumeProgram hook source (installed by head node UserData)
  slurm_suspend_node.sh — SuspendProgram hook source (installed by head node UserData)
  teardown.sh        — deletes the CFN stack

lambda/
  spot-handler.ts    — TypeScript source of the spot interruption handler (reference only;
                       the compiled JS is inlined in src/events.ts for CFN ZipFile deployment)

ssm/                 — reserved for future SSM document YAML sources (currently empty)
```

## Local verification

Verify the build and lint pass before touching AWS:

```bash
npm run build   # produces dist/infra.json and dist/slurm.conf — no AWS calls
npm run lint    # chant lint src (pre-synth checks)
```

## Phase-by-phase walkthrough

### Phase 1 — Build

Generates `dist/infra.json` (CloudFormation template) and `dist/slurm.conf` from the TypeScript source.

```bash
npm run build
# or separately:
npm run build:aws    # → dist/infra.json
npm run build:slurm  # → dist/slurm.conf
```

The Slurm lexicon post-synth checks run automatically during `build:slurm` and flag common misconfigurations (see `chant lint src` for pre-synth checks).

### Phase 2 — Deploy CloudFormation stack

`npm run deploy` handles this automatically, but you can run it manually:

```bash
aws cloudformation deploy \
  --stack-name eda-hpc-infra \
  --template-file dist/infra.json \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1
```

**Estimated time:** ~25 minutes. The long pole is FSx Lustre PERSISTENT_2 provisioning (8–15 min).

What gets created:
- VPC (10.0.0.0/16) with 3 private subnets + 1 public subnet
- Internet Gateway, NAT Gateway, Elastic IP for NAT
- Route tables and subnet associations (public → IGW, private → NAT)
- EFA cluster placement group
- Security groups (cluster, FSx, RDS)
- **Head node EC2 instance** (c5.2xlarge) with UserData bootstrap script
- FSx for Lustre PERSISTENT_2 (1200 GiB, 200 MB/s/TiB)
- Aurora MySQL Serverless v2 (0.5–4 ACU)
- IAM roles for head node and compute nodes
- GPU ASG (min 0, max 16 × p4d.24xlarge)
- ASG lifecycle hook (5-min termination delay for job requeue)
- EventBridge rule + Lambda for spot interruption handling
- SSM post-provision Automation document

### Phase 3 — Post-provision configuration

`deploy.sh` does two things after the CFN stack reaches `CREATE_COMPLETE`: it copies `dist/slurm.conf` to `/etc/slurm/slurm.conf` on the head node via `ssm:send-command`, then triggers the SSM Automation document for post-provision steps. This is why there are two build outputs — `infra.json` goes to CloudFormation; `slurm.conf` goes to the head node.

Runs 4 steps as an SSM Automation execution:

1. **GenerateMungeKey** — creates a 1024-byte random MUNGE authentication key, stores as SSM SecureString at `/${CLUSTER_NAME}/munge/key`
2. **ReconfigureSlurm** — reloads `slurm.conf` on the head node (`scontrol reconfigure`)
3. **WaitNodesJoin** — polls `sinfo` until at least one compute node appears (up to 15 min)
4. **SetupAccounts** — creates default `sacctmgr` cluster, account, and admin user

Track progress in the console:

```
https://us-east-1.console.aws.amazon.com/systems-manager/automation/executions
```

### Phase 4 — Validate

Once deployed, check the cluster is healthy:

```bash
# Connect to head node (no SSH bastion needed — SSM Session Manager)
aws ssm start-session \
  --target $(aws ec2 describe-instances \
    --filters Name=tag:role,Values=head Name=tag:cluster,Values=eda-hpc \
    --query "Reservations[0].Instances[0].InstanceId" --output text) \
  --region us-east-1

# On the head node:
sinfo                        # show partition/node state
squeue                       # show job queue
sshare -l                    # show fairshare scores
sacctmgr show cluster        # show accounting cluster
scontrol show config | grep -E "ClusterName|AuthType|SelectType|ProctrackType"
```

Submit a test job:

```bash
srun --partition=synthesis --ntasks=4 --cpus-per-task=1 hostname
# Should print 4 OS hostnames from the cpu[001-032] pool (e.g. ip-10-0-1-XX.us-east-1.compute.internal)
# To see Slurm node names instead: srun --partition=synthesis --ntasks=4 scontrol show hostname

# Test license tracking:
srun --partition=synthesis --licenses=eda_synth:1 sleep 10 &
squeue  # shows job with license reservation
```

Or run the automated validation suite from your local machine:

```bash
npm run e2e-test
```

`e2e-test.sh` checks the CFN stack status, head node, FSx and Aurora availability, SSM munge key parameter, munge authentication on the head node, and submits a short `srun` test job via SSM Run Command. Exit 0 means the cluster is fully operational.

### Phase 5 — GPU fleet

The GPU ASG starts at 0. Slurm's `ResumeProgram` scales it up when a job targets `gpu_eda`:

```bash
# Submit a GPU job — triggers ResumeProgram (scales ASG up)
srun --partition=gpu_eda --gres=gpu:a100:8 --nodes=2 \
  nvidia-smi --query-gpu=name --format=csv,noheader
```

The ASG provisions p4d.24xlarge instances in the EFA placement group. EFA is enabled via the launch template `InterfaceType: "efa"` — NCCL automatically uses the EFA fabric for collective ops.

After 5 minutes idle, `SuspendProgram` scales the ASG back to 0.

## Spot interruption handling

When AWS reclaims a spot instance, EventBridge fires within 2 minutes:

```
EC2 Spot Instance Interruption Warning
  → Lambda (spot-handler)
    → SSM Run Command on head node
      → scontrol update NodeName=<N> State=drain
      → squeue | xargs scontrol requeue
      → ASG lifecycle hook: CONTINUE (allow termination)
```

The Lambda runs in <30 seconds — within the 2-minute spot warning window. Requeued jobs start on other nodes immediately if capacity is available; otherwise they wait in queue for the next ResumeProgram cycle.

Monitor interruption rate:

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/AutoScaling \
  --metric-name WarmPoolTerminatedInstances \
  --dimensions Name=AutoScalingGroupName,Value=eda-hpc-gpu-asg \
  --start-time $(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%SZ) \
  --period 300 --statistics Sum
```

If interruption rate is high, add more instance types to `config.gpuInstanceTypes` and redeploy.

## Teardown

```bash
npm run teardown
```

**Warning:** This deletes the FSx filesystem. Any data on `/scratch` that hasn't been synced to S3 via a data repository association will be lost. Scale jobs down first.

## Cost estimates (us-east-1, approximate)

| Resource | Cost |
|---|---|
| FSx Lustre PERSISTENT_2, 1200 GiB | ~$312/month |
| Aurora Serverless v2, idle (0.5 ACU) | ~$45/month |
| Head node c5.2xlarge | ~$250/month |
| p4d.24xlarge spot × 1 (when running) | ~$10/hr |
| Lambda + EventBridge + SSM | < $5/month |

GPU nodes bill only when running (ASG scales to 0 when idle). A typical EDA workday with 8 hours of GPU usage costs ~$80 in GPU compute.

## Troubleshooting

**Head node can't reach Aurora MySQL:**
```bash
# Check security group allows port 3306 from clusterSg
aws ec2 describe-security-groups --group-ids <rdsSg-id> --query "SecurityGroups[0].IpPermissions"
# Check Aurora is in AVAILABLE state
aws rds describe-db-clusters --db-cluster-identifier eda-hpc-slurmdbd --query "DBClusters[0].Status"
```

**Nodes not joining after ResumeProgram:**
```bash
# Check ASG is scaling
aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names eda-hpc-gpu-asg \
  --query "AutoScalingGroups[0].{Desired:DesiredCapacity,InService:Instances[?LifecycleState=='InService']|length(@)}"
# Check slurmd on compute node (via SSM)
aws ssm send-command --instance-ids <instance-id> \
  --document-name AWS-RunShellScript \
  --parameters "commands=[\"systemctl status slurmd\"]"
```

**FSx not mounting on compute nodes:**
```bash
# Verify mount point exists and Lustre kernel module is loaded
aws ssm send-command --instance-ids <instance-id> \
  --document-name AWS-RunShellScript \
  --parameters "commands=[\"lsmod | grep lustre\", \"df -h /scratch\"]"
```

**Spot interruption Lambda not draining node:**
```bash
# Check Lambda logs
aws logs tail /aws/lambda/eda-hpc-spot-handler --since 1h
# Verify HEAD_NODE_ID env var is set on the Lambda function
aws lambda get-function-configuration --function-name eda-hpc-spot-handler \
  --query "Environment.Variables"
```

**slurmdbd accounting not recording jobs:**
```bash
# On head node: check slurmdbd is running and connected
sacctmgr show cluster
# If empty: restart slurmdbd and check /var/log/slurm/slurmdbd.log
```

**CFN stack stuck at CREATE_IN_PROGRESS:**

The head node UserData script has a 10-minute `CreationPolicy` timeout — if `cfn-signal` isn't received in time, the stack rolls back. To diagnose, connect via SSM before the rollback completes:
```bash
aws ssm start-session --target <head-node-instance-id> --region us-east-1
sudo tail -f /var/log/slurm-bootstrap.log
```
Common causes: missing IAM permissions preventing SSM agent start, or `aws s3 cp` of Slurm RPMs failing. Fix the underlying issue and redeploy.

**HEAD_NODE_ID SSM parameter not found (Lambda environment variable):**

The spot-handler Lambda uses `{{resolve:ssm:/${CLUSTER_NAME}/head-node-id}}` in its environment. CloudFormation resolves this at deploy time via a `DependsOn` on the head node resource. If you see `ParameterNotFound` in Lambda logs, the head node either hasn't finished booting or the UserData script failed to write the parameter. Check `/var/log/slurm-bootstrap.log` and redeploy after the head node is healthy.

**Compute nodes stuck in CLOUD state (ResumeProgram ran but ASG didn't scale):**
```bash
# Verify the head node IAM role has autoscaling permissions
aws iam simulate-principal-policy \
  --policy-source-arn $(aws ec2 describe-instances \
    --filters Name=tag:role,Values=head Name=tag:cluster,Values=eda-hpc \
    --query "Reservations[0].Instances[0].IamInstanceProfile.Arn" --output text) \
  --action-names autoscaling:SetDesiredCapacity \
  --resource-arns "*"
# Check ResumeProgram logs on the head node
sudo cat /var/log/slurm/slurmctld.log | grep -i resume
```

**munge: Authentication error on compute nodes:**

MUNGE requires all nodes to share the same key. The `GenerateMungeKey` SSM Automation step writes the key to SSM Parameter Store; the head node UserData and compute node launch template pull it from there. If you see `munge: ERROR: Failed to access "/var/run/munge/munge.socket.2"` or auth errors:
```bash
# Check the Automation step completed successfully
aws ssm list-command-invocations --filter key=DocumentName,value=eda-hpc-automation \
  --details --query "CommandInvocations[*].{Status:Status,Step:CommandPlugins[0].Name}"
# On the affected node, verify the key was installed
aws ssm start-session --target <instance-id>
sudo ls -la /etc/munge/munge.key   # should be owned by munge:munge, mode 0400
sudo systemctl restart munge && sudo systemctl status munge
```
