import { Job, Image, Service, Need, Rule } from "@intentius/chant-lexicon-gitlab";
import { CI } from "@intentius/chant-lexicon-gitlab";

const ECR_URL = "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com";
const ECR_REPO = "alb-api";
const STACK_NAME = "shared-alb-api";
const INFRA_STACK = "shared-alb";
const fullImage = `${ECR_URL}/${ECR_REPO}`;

const awsImage = new Image({ name: "amazon/aws-cli:latest", entrypoint: [""] });
const dockerImage = new Image({ name: "docker:27-cli" });
const dind = new Service({ name: "docker:27-dind", alias: "docker" });

const defaultBranchOnly = [
  new Rule({ if: "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH" }),
];

const dockerVariables = { DOCKER_TLS_CERTDIR: "/certs" };

export const buildImage = new Job({
  stage: "build",
  image: dockerImage,
  services: [dind],
  variables: dockerVariables,
  before_script: [
    "apk add --no-cache aws-cli",
    `aws ecr get-login-password | docker login --username AWS --password-stdin ${ECR_URL}`,
  ],
  script: [
    `docker build -t ${fullImage}:${CI.CommitRefSlug} .`,
    `docker push ${fullImage}:${CI.CommitRefSlug}`,
    `if [ "${CI.CommitBranch}" = "${CI.DefaultBranch}" ]; then docker tag ${fullImage}:${CI.CommitRefSlug} ${fullImage}:latest && docker push ${fullImage}:latest; fi`,
  ],
  rules: defaultBranchOnly,
});

export const deployService = new Job({
  stage: "deploy",
  image: awsImage,
  needs: [new Need({ job: "build-image" })],
  script: [
    `OUTPUTS=$(aws cloudformation describe-stacks --stack-name ${INFRA_STACK} --query 'Stacks[0].Outputs' --output json)`,
    `PARAMS=$(echo "$OUTPUTS" | jq -r '[(.[] | select(.OutputKey == "ClusterArn") | "clusterArn=" + .OutputValue), (.[] | select(.OutputKey == "ListenerArn") | "listenerArn=" + .OutputValue), (.[] | select(.OutputKey == "AlbSgId") | "albSgId=" + .OutputValue), (.[] | select(.OutputKey == "ExecutionRoleArn") | "executionRoleArn=" + .OutputValue), (.[] | select(.OutputKey == "VpcId") | "vpcId=" + .OutputValue), (.[] | select(.OutputKey == "PrivateSubnet1") | "privateSubnet1=" + .OutputValue), (.[] | select(.OutputKey == "PrivateSubnet2") | "privateSubnet2=" + .OutputValue)] | join(" ")')`,
    `IMAGE_URI=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey == "ApiRepoUri") | .OutputValue'):\${CI_COMMIT_REF_SLUG}`,
    `aws cloudformation deploy --template-file templates/template.json --stack-name ${STACK_NAME} --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides $PARAMS image=$IMAGE_URI`,
  ],
  rules: defaultBranchOnly,
});
