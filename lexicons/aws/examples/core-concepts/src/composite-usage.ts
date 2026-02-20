import * as _ from "./_";

export const api = _.$.LambdaService({
  name: _.Sub`${_.AWS.StackName}-api`,
  handler: "index.handler",
});
