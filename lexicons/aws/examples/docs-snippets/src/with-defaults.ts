import * as _ from "./_";

const SecureApi = _.withDefaults(_.$.LambdaApi, {
  runtime: "nodejs20.x",
  handler: "index.handler",
  timeout: 10,
  memorySize: 256,
});

export const healthApi = SecureApi({
  name: _.Sub`${_.AWS.StackName}-health`,
  code: { zipFile: `exports.handler = async () => ({ statusCode: 200 });` },
});

// Composable — stack defaults on top of defaults
export const HighMemoryApi = _.withDefaults(SecureApi, { memorySize: 2048, timeout: 25 });
