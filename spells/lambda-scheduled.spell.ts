import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "lambda-scheduled",
  lexicon: "aws",
  overview: "Deploy the lambda-scheduled example — cron-triggered Lambda using LambdaScheduled.",
  context: [
    file("lexicons/aws/examples/lambda-scheduled/README.md"),
  ],
  tasks: [
    task("Deploy the lambda-scheduled example at lexicons/aws/examples/lambda-scheduled", { done: true }),
    task("Take a state snapshot: chant state snapshot dev", { done: true }),
  ],
});
