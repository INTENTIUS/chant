import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "lambda-sns",
  lexicon: "aws",
  overview: "Deploy the lambda-sns example — Lambda triggered by SNS using LambdaSns.",
  context: [
    file("lexicons/aws/examples/lambda-sns/README.md"),
  ],
  tasks: [
    task("Deploy the lambda-sns example at lexicons/aws/examples/lambda-sns", { done: true }),
    task("Take a state snapshot: chant state snapshot dev", { done: true }),
  ],
});
