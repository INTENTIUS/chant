// GitLab CI pipeline — 4 stages: infra → system → validate → cells (matrix).
//
// The cells stage fans out using parallel:matrix, one job per cell.
// Cell names come from the config array at build time.

import { Job, Image, Rule, Parallel } from "@intentius/chant-lexicon-gitlab";
import { cells } from "../config";

const awsImage = new Image({ name: "amazon/aws-cli:latest", entrypoint: [""] });
const kubectlImage = new Image({ name: "bitnami/kubectl:1.31", entrypoint: [""] });

const onlyMain = [new Rule({ if: "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH" })];

// ── Stage 1: Deploy infrastructure (CloudFormation) ────────────────

export const deployInfra = new Job({
  stage: "infra",
  image: awsImage,
  script: [
    "aws cloudformation deploy --template-file templates/template.json --stack-name cells-cluster --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset",
    "aws eks update-kubeconfig --name cells-cluster --region $AWS_REGION",
  ],
  rules: onlyMain,
});

// ── Stage 2: Deploy system namespace ───────────────────────────────

export const deploySystem = new Job({
  stage: "system",
  image: kubectlImage,
  script: [
    "kubectl apply -f k8s.yaml -l app.kubernetes.io/part-of=system",
    "kubectl -n system rollout status deployment/ingress-nginx-controller --timeout=120s",
    "kubectl -n system rollout status deployment/prometheus --timeout=60s",
  ],
  needs: [{ job: "deploy-infra" }],
  rules: onlyMain,
});

// ── Stage 3: Validate (dry-run preview) ────────────────────────────

export const validate = new Job({
  stage: "validate",
  image: kubectlImage,
  script: [
    "kubectl diff -f k8s.yaml -l app.kubernetes.io/part-of=cells || true",
  ],
  needs: [{ job: "deploy-system" }],
  rules: onlyMain,
  allow_failure: true,
});

// ── Stage 4: Deploy cells (parallel matrix fan-out) ────────────────

export const deployCells = new Job({
  stage: "cells",
  image: kubectlImage,
  parallel: new Parallel({
    matrix: cells.map((c) => ({ CELL_NAME: c.name })),
  }),
  script: [
    "kubectl apply -f k8s.yaml -l cells.example.com/cell=$CELL_NAME",
    "kubectl -n cell-$CELL_NAME rollout status deployment/$CELL_NAME-app --timeout=120s",
  ],
  needs: [{ job: "validate" }],
  rules: onlyMain,
});
