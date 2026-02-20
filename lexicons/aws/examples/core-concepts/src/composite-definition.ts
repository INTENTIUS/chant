import { Sub, Role, Function } from "@intentius/chant-lexicon-aws";
import { Composite } from "@intentius/chant";

interface LambdaServiceProps {
  name: string | ReturnType<typeof Sub>;
  handler: string;
  runtime?: string;
  timeout?: number;
}

export const LambdaService = Composite<LambdaServiceProps>((props) => {
  const role = new Role({
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      }],
    },
  });

  const func = new Function({
    functionName: props.name,
    handler: props.handler,
    runtime: props.runtime ?? "nodejs20.x",
    role: role.arn,
    timeout: props.timeout ?? 30,
    code: { zipFile: "exports.handler = async () => ({});" },
  });

  return { role, func };
}, "LambdaService");
