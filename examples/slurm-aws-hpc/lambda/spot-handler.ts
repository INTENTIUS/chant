/**
 * Spot interruption handler — drains the Slurm node and requeues its jobs.
 *
 * Triggered by EventBridge when EC2 sends "EC2 Spot Instance Interruption Warning".
 * The 2-minute warning window is enough to:
 *   1. Drain the node (prevent new job placement)
 *   2. Requeue all running jobs (they start on other nodes immediately)
 *   3. Complete the ASG lifecycle hook (allows termination)
 *
 * The Lambda runs in <10s — well within the 2-minute window.
 */

import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";
import {
  AutoScalingClient,
  CompleteLifecycleActionCommand,
} from "@aws-sdk/client-auto-scaling";

const ssm = new SSMClient({});
const asg = new AutoScalingClient({});

interface SpotInterruptionEvent {
  detail: {
    "instance-id": string;
  };
}

export const handler = async (event: SpotInterruptionEvent): Promise<void> => {
  const instanceId = event.detail["instance-id"];
  const headNodeId = process.env.HEAD_NODE_ID!;
  const clusterName = process.env.CLUSTER_NAME!;

  console.log(`Spot interruption: instance ${instanceId}`);

  // Run drain + requeue on the head node via SSM Run Command
  const cmd = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [headNodeId],
      DocumentName: "AWS-RunShellScript",
      Parameters: {
        commands: [
          // Resolve EC2 instance ID → private IP → Slurm node name via NodeAddr
          `PRIVATE_IP=$(aws ec2 describe-instances --instance-ids ${instanceId} --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text)`,
          `NODE_NAME=$(scontrol show nodes | grep -B5 "NodeAddr=$PRIVATE_IP" | grep NodeName | awk '{print $1}' | sed 's/NodeName=//')`,
          `if [ -z "$NODE_NAME" ]; then echo "Node not found in Slurm for instance ${instanceId} (IP=$PRIVATE_IP)"; exit 0; fi`,
          // Drain the node (new jobs won't be scheduled here)
          `scontrol update NodeName=$NODE_NAME State=drain Reason="spot-interruption-${instanceId}"`,
          // Requeue any running jobs on this node so they start elsewhere
          `squeue -w $NODE_NAME -h -o '%i' | xargs -r -n1 scontrol requeue`,
          `echo "Drained $NODE_NAME and requeued its jobs"`,
        ],
      },
      TimeoutSeconds: 30,
    })
  );

  const commandId = cmd.Command!.CommandId!;

  // Wait for Run Command to complete (poll up to 45s)
  for (let i = 0; i < 9; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const result = await ssm.send(
      new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: headNodeId })
    );
    if (result.Status === "Success" || result.Status === "Failed") {
      console.log(`Run Command status: ${result.Status}`);
      console.log(result.StandardOutputContent);
      break;
    }
  }

  // Complete the lifecycle hook so ASG can proceed with termination
  try {
    await asg.send(
      new CompleteLifecycleActionCommand({
        AutoScalingGroupName: `${clusterName}-gpu-asg`,
        LifecycleHookName: `${clusterName}-spot-termination-hook`,
        LifecycleActionResult: "CONTINUE",
        InstanceId: instanceId,
      })
    );
    console.log("Lifecycle hook completed");
  } catch (e) {
    // Hook may have already expired — not fatal
    console.warn("Could not complete lifecycle hook (may have already expired):", e);
  }
};
