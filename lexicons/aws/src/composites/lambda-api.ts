import { Composite } from "@intentius/chant";
import { Permission } from "../generated";
import { LambdaFunction, type LambdaFunctionProps } from "./lambda-function";

export interface LambdaApiProps extends LambdaFunctionProps {
  sourceArn?: string;
}

export const LambdaApi = Composite<LambdaApiProps>((props) => {
  const { role, func } = LambdaFunction(props);

  const permission = new Permission({
    FunctionName: func.Arn,
    Action: "lambda:InvokeFunction",
    Principal: "apigateway.amazonaws.com",
    SourceArn: props.sourceArn,
  });

  return { role, func, permission };
}, "LambdaApi");
