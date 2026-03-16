import { Composite, mergeDefaults } from "@intentius/chant";
import { Permission } from "../generated";
import { LambdaFunction, type LambdaFunctionProps } from "./lambda-function";

export interface LambdaApiProps extends LambdaFunctionProps {
  sourceArn?: string;
  defaults?: LambdaFunctionProps["defaults"] & {
    permission?: Partial<ConstructorParameters<typeof Permission>[0]>;
  };
}

export const LambdaApi = Composite<LambdaApiProps>((props) => {
  const { defaults } = props;
  const { role, func } = LambdaFunction(props);

  const permission = new Permission(mergeDefaults({
    FunctionName: func.Arn,
    Action: "lambda:InvokeFunction",
    Principal: "apigateway.amazonaws.com",
    SourceArn: props.sourceArn,
  }, defaults?.permission));

  return { role, func, permission };
}, "LambdaApi");
