import { spell, task, file } from "@intentius/chant";

export default spell({
  name: "lambda-s3",
  lexicon: "aws",
  overview: "Deploy the lambda-s3 example — Lambda with S3 bucket using LambdaS3.",
  context: [
    file("lexicons/aws/examples/lambda-s3/README.md"),
  ],
  tasks: [
    task("Deploy the lambda-s3 example at lexicons/aws/examples/lambda-s3", { done: true }),
    task("Take a state snapshot: chant state snapshot dev", { done: true }),
  ],
});
