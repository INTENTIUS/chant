import { Job, Image, Rule, Parallel } from "@intentius/chant-lexicon-gitlab";
import { cells } from "../config";

const gcloudImage = new Image({ name: "google/cloud-sdk:slim", entrypoint: [""] });
const kubectlImage = new Image({ name: "bitnami/kubectl:1.31", entrypoint: [""] });
const helmImage = new Image({ name: "alpine/helm:3.14", entrypoint: [""] });
const nodeImage = new Image({ name: "node:20-slim", entrypoint: [""] });

const onlyMain = [new Rule({ if: "$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH" })];
const canaryCells = cells.filter(c => c.canary);
const remainingCells = cells.filter(c => !c.canary);

// Stage 1: infra (Config Connector resources)
export const deployInfra = new Job({ stage: "infra", image: kubectlImage, script: [
  "kubectl apply -f config.yaml",
  "echo 'Waiting for Config Connector resources to reconcile...'",
  "kubectl wait --for=condition=Ready sqlinstances --all --timeout=600s",
], rules: onlyMain });

// Stage 2: system (kubectl apply system namespace + install cert-manager + ESO)
export const deploySystem = new Job({ stage: "system", image: gcloudImage, script: [
  "kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.4/cert-manager.yaml || true",
  "helm repo add external-secrets https://charts.external-secrets.io",
  "helm upgrade --install external-secrets external-secrets/external-secrets -n kube-system --set installCRDs=true --wait || true",
  "kubectl apply -f k8s.yaml -l app.kubernetes.io/part-of=system",
  "kubectl -n system rollout status deployment/ingress-nginx-controller --timeout=120s",
  "kubectl -n system rollout status deployment/cell-router --timeout=120s",
], needs: [{ job: "deploy-infra" }], rules: onlyMain });

// Stage 3a: build-helm-values — generate gitlab-cell/values-<cell>.yaml from TypeScript.
// Per-cell IPs (ALPHA_DB_IP, ALPHA_REDIS_PERSISTENT, etc.) must be set as CI/CD variables
// in GitLab project settings; they are written to .env by load-outputs.sh on first deploy.
export const buildHelmValues = new Job({ stage: "build-helm-values", image: nodeImage,
  script: [
    "npm ci",
    "npm run build:helm",
  ],
  artifacts: {
    paths: ["gitlab-cell/values-*.yaml"],
    expire_in: "1 hour",
  },
  needs: [{ job: "deploy-system" }], rules: onlyMain });

// Stage 3b: validate (helm diff dry-run)
const helmDiffCmds = cells.map(c =>
  `helm diff upgrade gitlab-cell-${c.name} ./gitlab-cell/ -n cell-${c.name} -f gitlab-cell/values-base.yaml -f gitlab-cell/values-${c.name}.yaml || true`
);
export const validate = new Job({ stage: "validate", image: helmImage, allow_failure: true,
  script: [
    "helm dependency update ./gitlab-cell/",
    ...helmDiffCmds,
  ],
  needs: [{ job: "build-helm-values" }], rules: onlyMain });

// Stage 4: deploy-canary (helm install canary cell)
export const deployCanary = new Job({ stage: "deploy-canary", image: helmImage, script: [
  "helm dependency update ./gitlab-cell/",
  `helm upgrade --install gitlab-cell-${canaryCells[0].name} ./gitlab-cell/ -n cell-${canaryCells[0].name} -f gitlab-cell/values-base.yaml -f gitlab-cell/values-${canaryCells[0].name}.yaml --wait --timeout=900s`,
  `kubectl -n cell-${canaryCells[0].name} rollout status deployment/gitlab-cell-${canaryCells[0].name}-webservice-default --timeout=300s`,
], needs: [{ job: "validate" }], rules: onlyMain });

// Stage 5: deploy-remaining (parallel matrix for non-canary cells)
export const deployRemaining = new Job({ stage: "deploy-remaining", image: helmImage,
  parallel: new Parallel({ matrix: remainingCells.map(c => ({ CELL_NAME: c.name })) }),
  script: [
    "helm dependency update ./gitlab-cell/",
    "helm upgrade --install gitlab-cell-$CELL_NAME ./gitlab-cell/ -n cell-$CELL_NAME -f gitlab-cell/values-base.yaml -f gitlab-cell/values-$CELL_NAME.yaml --wait --timeout=900s",
    "kubectl -n cell-$CELL_NAME rollout status deployment/gitlab-cell-$CELL_NAME-webservice-default --timeout=300s",
  ],
  needs: [{ job: "deploy-canary" }], rules: onlyMain });

// Stage 6: register-runners — per-cell matrix job.
// Each cell creates a runner token in its own toolbox, stores it as a K8s secret
// in the cell namespace, then restarts that cell's runner Deployment.
// GitLab 17.7+ auto-generates the routable token prefix glrt-t${cellId}_ based on
// global.cells.id — token_prefix is not a model attribute and must not be passed.
export const registerRunners = new Job({ stage: "register-runners", image: gcloudImage,
  parallel: new Parallel({ matrix: cells.map(c => ({ CELL_NAME: c.name })) }),
  script: [
    "RUNNER_TOKEN=$(kubectl -n cell-$CELL_NAME exec deploy/gitlab-cell-$CELL_NAME-toolbox -- gitlab-rails runner 'puts Ci::Runner.create!(runner_type: :instance_type, registration_type: :authenticated_user).token')",
    "kubectl -n cell-$CELL_NAME create secret generic $CELL_NAME-runner-token --from-literal=token=$RUNNER_TOKEN --dry-run=client -o yaml | kubectl apply -f -",
    "kubectl -n cell-$CELL_NAME rollout restart deploy/$CELL_NAME-runner",
    "kubectl -n cell-$CELL_NAME rollout status deploy/$CELL_NAME-runner --timeout=120s",
  ],
  needs: [{ job: "deploy-remaining" }], rules: onlyMain });

// Stage 7: smoke-test (E2E validation)
export const smokeTest = new Job({ stage: "smoke-test", image: gcloudImage, script: [
  "bash scripts/e2e-test.sh",
], needs: [{ job: "register-runners" }], rules: onlyMain });

// Stage 8: backup (scheduled — full GitLab backup per cell to GCS via backup-utility)
// backup-utility runs inside the toolbox and writes to the configured GCS artifact bucket
// using Workload Identity. It backs up repos (via Gitaly), uploads, LFS, and packages.
// Cloud SQL is backed up independently by GCP's automated backup schedule.
export const backupGitaly = new Job({ stage: "backup", image: gcloudImage,
  parallel: new Parallel({ matrix: cells.map(c => ({ CELL_NAME: c.name })) }),
  script: [
    "kubectl -n cell-$CELL_NAME exec deploy/gitlab-cell-$CELL_NAME-toolbox -- backup-utility --skip-registry",
  ],
  rules: [new Rule({ if: "$CI_PIPELINE_SOURCE == 'schedule'" })],
});

// Stage 9: migrate-org (manual)
export const migrateOrg = new Job({ stage: "migrate-org", when: "manual", image: kubectlImage,
  script: [
    "echo 'Update Topology Service to reassign org to target cell'",
    "kubectl -n system exec deploy/topology-service -- topology-cli migrate-org --org $ORG_ID --target-cell $TARGET_CELL",
  ],
  rules: onlyMain });
