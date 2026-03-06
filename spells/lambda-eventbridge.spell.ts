import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "lambda-eventbridge",
  lexicon: "aws",
  overview: "Deploy the lambda-eventbridge example — Lambda with EventBridge rule using LambdaEventBridge.",
  context: [
    file("lexicons/aws/examples/lambda-eventbridge/README.md"),
  ],
  tasks: [
    task("Deploy the lambda-eventbridge example at lexicons/aws/examples/lambda-eventbridge", { done: true }),
    task("Take a state snapshot: chant state snapshot dev", { done: true }),
  ],
});
