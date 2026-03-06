import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "lambda-sqs",
  lexicon: "aws",
  overview: "Deploy the lambda-sqs example — Lambda triggered by SQS using LambdaSqs.",
  context: [
    file("lexicons/aws/examples/lambda-sqs/README.md"),
  ],
  tasks: [
    task("Deploy the lambda-sqs example at lexicons/aws/examples/lambda-sqs", { done: true }),
    task("Take a state snapshot: chant state snapshot dev", { done: true }),
  ],
});
