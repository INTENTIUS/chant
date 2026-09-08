import { Job, Need } from "@intentius/chant-lexicon-gitlab";
import { CI } from "@intentius/chant-lexicon-gitlab";
import { awsImage, dockerImage, dind, defaultBranchOnly, dockerVariables, ecrLogin, ecrUrl } from "./ci";

const API_REPO = "alb-api";
const UI_REPO = "alb-ui";
const STACK_NAME = "shared-alb-services";
const INFRA_STACK = "shared-alb";
const apiImageName = `${ecrUrl}/${API_REPO}`;
const uiImageName = `${ecrUrl}/${UI_REPO}`;

// One build job per service image. The two are identical apart from the image
// name and the Dockerfile, and they run in parallel in the build stage.
export const buildApiImage = new Job({
  stage: "build",
  image: dockerImage,
  services: [dind],
  variables: dockerVariables,
  before_script: ecrLogin,
  script: [
    `docker build -f Dockerfile.api -t ${apiImageName}:${CI.CommitRefSlug} .`,
    `docker push ${apiImageName}:${CI.CommitRefSlug}`,
    `if [ "${CI.CommitBranch}" = "${CI.DefaultBranch}" ]; then docker tag ${apiImageName}:${CI.CommitRefSlug} ${apiImageName}:latest && docker push ${apiImageName}:latest; fi`,
  ],
  rules: defaultBranchOnly,
});

export const buildUiImage = new Job({
  stage: "build",
  image: dockerImage,
  services: [dind],
  variables: dockerVariables,
  before_script: ecrLogin,
  script: [
    `docker build -f Dockerfile.ui -t ${uiImageName}:${CI.CommitRefSlug} .`,
    `docker push ${uiImageName}:${CI.CommitRefSlug}`,
    `if [ "${CI.CommitBranch}" = "${CI.DefaultBranch}" ]; then docker tag ${uiImageName}:${CI.CommitRefSlug} ${uiImageName}:latest && docker push ${uiImageName}:latest; fi`,
  ],
  rules: defaultBranchOnly,
});

// Both services are in one template, so one deploy job applies both. It waits
// on both image builds because the stack takes both image URIs as parameters.
export const deployServices = new Job({
  stage: "deploy",
  image: awsImage,
  needs: [new Need({ job: "build-api-image" }), new Need({ job: "build-ui-image" })],
  script: [
    `OUTPUTS=$(aws cloudformation describe-stacks --stack-name ${INFRA_STACK} --query 'Stacks[0].Outputs' --output json)`,
    `PARAMS=$(echo "$OUTPUTS" | jq -r '[(.[] | select(.OutputKey == "ClusterArn") | "clusterArn=" + .OutputValue), (.[] | select(.OutputKey == "ListenerArn") | "listenerArn=" + .OutputValue), (.[] | select(.OutputKey == "AlbSgId") | "albSgId=" + .OutputValue), (.[] | select(.OutputKey == "ExecutionRoleArn") | "executionRoleArn=" + .OutputValue), (.[] | select(.OutputKey == "VpcId") | "vpcId=" + .OutputValue), (.[] | select(.OutputKey == "PrivateSubnet1") | "privateSubnet1=" + .OutputValue), (.[] | select(.OutputKey == "PrivateSubnet2") | "privateSubnet2=" + .OutputValue)] | join(" ")')`,
    `API_IMAGE_URI=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey == "ApiRepoUri") | .OutputValue'):\${CI_COMMIT_REF_SLUG}`,
    `UI_IMAGE_URI=$(echo "$OUTPUTS" | jq -r '.[] | select(.OutputKey == "UiRepoUri") | .OutputValue'):\${CI_COMMIT_REF_SLUG}`,
    `aws cloudformation deploy --template-file templates/template.json --stack-name ${STACK_NAME} --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset --parameter-overrides $PARAMS apiImage=$API_IMAGE_URI uiImage=$UI_IMAGE_URI`,
  ],
  rules: defaultBranchOnly,
});
