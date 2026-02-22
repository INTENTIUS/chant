import { Composite, withDefaults } from "@intentius/chant";
import { Function as LambdaFunction } from "@intentius/chant-lexicon-aws";

interface ApiProps {
  name: string;
  handler: string;
  timeout: number;
  memorySize: number;
  code: { ZipFile: string };
}

const Api = Composite<ApiProps>((props) => ({
  fn: new LambdaFunction({
    FunctionName: props.name,
    Handler: props.handler,
    Timeout: props.timeout,
    MemorySize: props.memorySize,
    Code: props.code,
  }),
}), "Api");

// Function-based defaults can compute values from caller props
const SmartApi = withDefaults(Api, (props) => ({
  handler: "index.handler",
  // Scale timeout with memory — higher memory → longer timeout
  timeout: (props.memorySize ?? 128) >= 1024 ? 60 : 10,
  memorySize: 256,
}));

export const fast = SmartApi({
  name: "fast-api",
  code: { ZipFile: `exports.handler = async () => ({ statusCode: 200 });` },
});

// memorySize >= 1024 triggers the longer timeout
export const heavy = SmartApi({
  name: "heavy-api",
  memorySize: 2048,
  code: { ZipFile: `exports.handler = async () => ({ statusCode: 200 });` },
});
