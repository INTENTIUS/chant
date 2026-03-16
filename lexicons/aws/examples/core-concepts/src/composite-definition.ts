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
    AssumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: "sts:AssumeRole",
      }],
    },
  });

  const func = new Function({
    FunctionName: props.name,
    Handler: props.handler,
    Runtime: props.runtime ?? "nodejs20.x",
    Role: role.Arn,
    Timeout: props.timeout ?? 30,
    Code: { ZipFile: "exports.handler = async () => ({});" },
  });

  return { role, func };
}, "LambdaService");
