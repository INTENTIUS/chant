import { Sub, AWS, Function as LambdaFunction } from "@intentius/chant-lexicon-aws";
import { Composite, withDefaults, type Value } from "@intentius/chant";

interface LambdaApiProps {
  // `Value<string>`, because the snippet below fills it with `Sub` — a prop a
  // reader will build from an intrinsic should say so.
  name: Value<string>;
  runtime: string;
  handler: string;
  timeout: number;
  memorySize: number;
  code: { ZipFile: string };
}

const LambdaApi = Composite<LambdaApiProps>((props) => ({
  fn: new LambdaFunction({
    FunctionName: props.name,
    Runtime: props.runtime,
    Handler: props.handler,
    Timeout: props.timeout,
    MemorySize: props.memorySize,
    Code: props.code,
  }),
}), "LambdaApi");

const SecureApi = withDefaults(LambdaApi, {
  runtime: "nodejs20.x",
  handler: "index.handler",
  timeout: 10,
  memorySize: 256,
});

export const healthApi = SecureApi({
  name: Sub`${AWS.StackName}-health`,
  code: { ZipFile: `exports.handler = async () => ({ statusCode: 200 });` },
});

// Composable — stack defaults on top of defaults
export const HighMemoryApi = withDefaults(SecureApi, { memorySize: 2048, timeout: 25 });
