/**
 * Spot interruption handling: EventBridge → Lambda → drain + requeue.
 *
 * Why Lambda over Slurm's built-in SuspendProgram:
 *   - EC2 Spot Interruption Warning fires 2 minutes before termination
 *   - Lambda handles drain + requeue in <30s, well within the window
 *   - EventBridge pattern matches instance-id → Lambda reads Slurm node mapping
 *   - No long-running workflow needed — Lambda is stateless
 */

import { Function, EventRule, Permission } from "@intentius/chant-lexicon-aws";
import { EventRule_Target } from "@intentius/chant-lexicon-aws";
import { Sub } from "@intentius/chant-lexicon-aws";
import { spotHandlerRole } from "./iam";
import { headNode } from "./head-node";
import { config } from "./config";

// Inline handler — see lambda/spot-handler.ts for the full TypeScript source.
// ZipFile accepts plain JS only, so this is the compiled form bundled inline.
// @aws-sdk/client-ssm is available in the Node.js 20 managed runtime.
// HEAD_NODE_ID is looked up from SSM at invocation time (not deploy time) because
// the SSM parameter is written by the head node's first-boot UserData script.
const SPOT_HANDLER_CODE = `
exports.handler = async (event) => {
  const instanceId = event.detail['instance-id'];
  const { SSMClient, SendCommandCommand, GetParameterCommand } = require('@aws-sdk/client-ssm');
  const ssm = new SSMClient({});
  const { Parameter } = await ssm.send(new GetParameterCommand({
    Name: '/' + process.env.CLUSTER_NAME + '/head-node/instance-id',
  }));
  const headNodeId = Parameter.Value;
  await ssm.send(new SendCommandCommand({
    InstanceIds: [headNodeId],
    DocumentName: 'AWS-RunShellScript',
    Parameters: {
      commands: [
        \`PRIVATE_IP=$(aws ec2 describe-instances --instance-ids \${instanceId} --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text)\`,
        \`NODE_NAME=$(scontrol show nodes | grep -B5 "NodeAddr=$PRIVATE_IP" | grep NodeName | awk '{print $1}' | sed 's/NodeName=//')\`,
        \`[ -z "$NODE_NAME" ] && exit 0\`,
        \`scontrol update NodeName=$NODE_NAME State=drain Reason="spot-interruption-\${instanceId}"\`,
        \`squeue -w $NODE_NAME -h -o '%i' | xargs -r -n1 scontrol requeue\`,
      ],
    },
  }));
};
`.trim();

export const spotHandlerFn = new Function({
  FunctionName: Sub("\${AWS::StackName}-spot-handler"),
  Runtime: "nodejs20.x",
  Role: spotHandlerRole.Arn,
  Handler: "index.handler",
  Timeout: 60,
  Code: {
    ZipFile: SPOT_HANDLER_CODE,
  },
  Environment: {
    Variables: {
      CLUSTER_NAME: Sub("\${AWS::StackName}"),
    },
  },
}, { DependsOn: headNode });

// EventBridge rule: EC2 Spot Instance Interruption Warning
export const spotInterruptionRule = new EventRule({
  Name: Sub("\${AWS::StackName}-spot-interruption"),
  Description: "Drain and requeue Slurm jobs on spot interruption",
  State: "ENABLED",
  EventPattern: {
    "source": ["aws.ec2"],
    "detail-type": ["EC2 Spot Instance Interruption Warning"],
  },
  Targets: [
    new EventRule_Target({
      Id: "SpotHandlerLambda",
      Arn: spotHandlerFn.Arn,
    }),
  ],
});

export const spotHandlerPermission = new Permission({
  FunctionName: spotHandlerFn.Arn,
  Action: "lambda:InvokeFunction",
  Principal: "events.amazonaws.com",
  SourceArn: spotInterruptionRule.Arn,
});
