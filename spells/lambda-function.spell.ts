import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "lambda-function",
  lexicon: "aws",
  overview: "Deploy the lambda-function example — a single Node.js Lambda using LambdaNode.",
  context: [
    file("lexicons/aws/examples/lambda-function/README.md"),
  ],
  tasks: [
    task("Deploy the lambda-function example at lexicons/aws/examples/lambda-function", { done: true }),
    task("Take a state snapshot: chant state snapshot dev", { done: true }),
  ],
});
