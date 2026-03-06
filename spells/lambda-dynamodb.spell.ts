import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "lambda-dynamodb",
  lexicon: "aws",
  overview: "Deploy the lambda-dynamodb example — Lambda with DynamoDB using LambdaDynamoDB.",
  context: [
    file("lexicons/aws/examples/lambda-dynamodb/README.md"),
  ],
  tasks: [
    task("Deploy the lambda-dynamodb example at lexicons/aws/examples/lambda-dynamodb", { done: true }),
    task("Take a state snapshot: chant state snapshot dev", { done: true }),
  ],
});
