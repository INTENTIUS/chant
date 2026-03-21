#!/bin/bash
# Called by Slurm ResumeProgram with node name as $1.
# Scales the GPU ASG up by 1 instance to provision a new node.
# Installed to /usr/local/bin/slurm_resume_node by head node UserData.
NODE_NAME="$1"
ASG_NAME="${CLUSTER_NAME}-gpu-asg"
CURRENT=$(aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names "$ASG_NAME" \
  --query "AutoScalingGroups[0].DesiredCapacity" --output text)
aws autoscaling set-desired-capacity \
  --auto-scaling-group-name "$ASG_NAME" \
  --desired-capacity $((CURRENT + 1))
