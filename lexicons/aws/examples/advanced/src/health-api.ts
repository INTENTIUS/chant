import * as _ from "./_";

export const healthApi = _.$.SecureApi({
  name: _.Sub`${_.AWS.StackName}-health`,
  runtime: "nodejs20.x",
  handler: "index.handler",
  code: {
    zipFile: `exports.handler = async () => ({
      statusCode: 200,
      body: JSON.stringify({ status: 'healthy' })
    });`,
  },
});
