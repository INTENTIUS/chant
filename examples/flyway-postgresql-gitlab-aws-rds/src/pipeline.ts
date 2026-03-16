import { Job, Image, Rule } from "@intentius/chant-lexicon-gitlab";

const awsImage = new Image({ name: "amazon/aws-cli:latest", entrypoint: [""] });

const defaultBranchOnly = [
  new Rule({ if: "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH" }),
];

// Stage 1: deploy CloudFormation stack
export const deployInfra = new Job({
  stage: "deploy",
  image: awsImage,
  script: [
    "aws cloudformation deploy --template-file templates/template.json --stack-name flyway-rds --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset",
  ],
  rules: defaultBranchOnly,
});

// Stage 2: run Flyway migrations against the RDS endpoint
export const runMigrations = new Job({
  stage: "migrate",
  image: awsImage,
  needs: ["deploy-infra"],
  before_script: [
    "yum install -y java-17-amazon-corretto-headless tar gzip",
    "curl -sL https://download.red-gate.com/maven/release/com/redgate/flyway/flyway-commandline/10.21.0/flyway-commandline-10.21.0-linux-x64.tar.gz | tar xz -C /opt",
    "ln -s /opt/flyway-10.21.0 /opt/flyway",
    "export DB_HOST=$(aws cloudformation describe-stacks --stack-name flyway-rds --query 'Stacks[0].Outputs[?OutputKey==`DbEndpoint`].OutputValue' --output text)",
    "export DB_PASSWORD=$(aws ssm get-parameter --name /myapp/dev/db-password --with-decryption --query 'Parameter.Value' --output text)",
  ],
  script: [
    "/opt/flyway/flyway -configFiles=flyway.toml -environment=deploy migrate",
  ],
  rules: defaultBranchOnly,
});
