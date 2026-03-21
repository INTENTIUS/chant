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
import { Sub, GetAtt } from "@intentius/chant-lexicon-aws";
import { spotHandlerRole } from "./iam";
import { config } from "./config";

// Inline handler — production would use a deployment package / Lambda Layer
// See lambda/spot-handler.ts for the full implementation
const SPOT_HANDLER_CODE = `
exports.handler = async (event) => {
  const instanceId = event.detail['instance-id'];
  const { SSMClient, SendCommandCommand } = require('@aws-sdk/client-ssm');
  const ssm = new SSMClient({});
  // Drain the node and requeue its jobs via scontrol + squeue + scontrol requeue
  await ssm.send(new SendCommandCommand({
    InstanceIds: [process.env.HEAD_NODE_ID],
    DocumentName: 'AWS-RunShellScript',
    Parameters: {
      commands: [
        \`/usr/bin/scontrol update NodeName=$(sinfo -N -n ${instanceId} -h -o %N) State=drain Reason="spot-interruption"\`,
        \`/usr/bin/squeue -w $(sinfo -N -n ${instanceId} -h -o %N) -h -o %i | xargs -r scontrol requeue\`,
      ],
    },
  }));
};
`.trim();

export const spotHandlerFn = new Function({
  FunctionName: Sub(`${config.clusterName}-spot-handler`),
  Runtime: "nodejs20.x",
  Role: spotHandlerRole.Arn,
  Handler: "index.handler",
  Timeout: 60,
  Code: {
    ZipFile: SPOT_HANDLER_CODE,
  },
  Environment: {
    Variables: {
      CLUSTER_NAME: config.clusterName,
    },
  },
});

// EventBridge rule: EC2 Spot Instance Interruption Warning
export const spotInterruptionRule = new EventRule({
  Name: Sub(`${config.clusterName}-spot-interruption`),
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
