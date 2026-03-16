import { Job, Image, Rule } from "@intentius/chant-lexicon-gitlab";

const awsImage = new Image({ name: "amazon/aws-cli:latest", entrypoint: [""] });

export const deployInfra = new Job({
  stage: "deploy",
  image: awsImage,
  script: [
    "aws cloudformation deploy --template-file templates/template.json --stack-name shared-alb --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset",
  ],
  rules: [
    new Rule({ if: "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH" }),
  ],
});
