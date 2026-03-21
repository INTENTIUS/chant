#!/bin/bash
# Called by Slurm SuspendProgram with node name as $1.
# Scales the GPU ASG down by 1 instance when a node goes idle.
# Installed to /usr/local/bin/slurm_suspend_node by head node UserData.
NODE_NAME="$1"
ASG_NAME="${CLUSTER_NAME}-gpu-asg"
CURRENT=$(aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names "$ASG_NAME" \
  --query "AutoScalingGroups[0].DesiredCapacity" --output text)
[ "$CURRENT" -gt 0 ] && aws autoscaling set-desired-capacity \
  --auto-scaling-group-name "$ASG_NAME" \
  --desired-capacity $((CURRENT - 1))
