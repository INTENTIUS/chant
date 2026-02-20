import * as _ from "./_";

interface LambdaServiceProps {
  name: string | ReturnType<typeof _.Sub>;
  handler: string;
  runtime?: string;
  timeout?: number;
}

export const LambdaService = _.Composite<LambdaServiceProps>((props) => {
  const role = new _.Role({
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      }],
    },
  });

  const func = new _.Function({
    functionName: props.name,
    handler: props.handler,
    runtime: props.runtime ?? "nodejs20.x",
    role: role.arn,
    timeout: props.timeout ?? 30,
    code: { zipFile: "exports.handler = async () => ({});" },
  });

  return { role, func };
}, "LambdaService");
