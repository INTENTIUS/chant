import { Image, Service, Rule } from "@intentius/chant-lexicon-gitlab";

// The GitLab runner plumbing both build jobs and the deploy job share. It
// lives in its own file because pipeline.ts is at COR009's Declarable limit
// with the three jobs and their `Need`s.

const ECR_URL = "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com";

/** `amazon/aws-cli` sets `aws` as its entrypoint; GitLab prepends the image
 * entrypoint to every `script` line, so `aws cloudformation deploy` would run
 * as `aws aws cloudformation deploy`. `entrypoint: [""]` is the fix. */
export const awsImage = new Image({ name: "amazon/aws-cli:latest", entrypoint: [""] });

export const dockerImage = new Image({ name: "docker:27-cli" });
export const dind = new Service({ name: "docker:27-dind", alias: "docker" });

export const defaultBranchOnly = [
  new Rule({ if: "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH" }),
];

export const dockerVariables = { DOCKER_TLS_CERTDIR: "/certs" };

export const ecrUrl = ECR_URL;

export const ecrLogin = [
  "apk add --no-cache aws-cli",
  `aws ecr get-login-password | docker login --username AWS --password-stdin ${ECR_URL}`,
];
