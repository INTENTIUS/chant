import { Job, Image, Rule, Parallel } from "@intentius/chant-lexicon-gitlab";
import { cells } from "../config";

const gcloudImage = new Image({ name: "google/cloud-sdk:slim", entrypoint: [""] });
const kubectlImage = new Image({ name: "bitnami/kubectl:1.31", entrypoint: [""] });
const helmImage = new Image({ name: "alpine/helm:3.14", entrypoint: [""] });

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
  "helm upgrade --install external-secrets external-secrets/external-secrets -n system --wait || true",
  "kubectl apply -f k8s.yaml -l app.kubernetes.io/part-of=system",
  "kubectl -n system rollout status deployment/ingress-nginx-controller --timeout=120s",
  "kubectl -n system rollout status deployment/cell-router --timeout=120s",
], needs: [{ job: "deploy-infra" }], rules: onlyMain });

// Stage 3: validate (helm diff dry-run)
export const validate = new Job({ stage: "validate", image: helmImage, allow_failure: true,
  script: cells.map(c =>
    `helm diff upgrade gitlab-cell-${c.name} ./gitlab-cell/ -n cell-${c.name} -f values-${c.name}.yaml || true`
  ),
  needs: [{ job: "deploy-system" }], rules: onlyMain });

// Stage 4: deploy-canary (helm install canary cell)
export const deployCanary = new Job({ stage: "deploy-canary", image: helmImage, script: [
  `helm upgrade --install gitlab-cell-${canaryCells[0].name} ./gitlab-cell/ -n cell-${canaryCells[0].name} -f values-${canaryCells[0].name}.yaml --wait --timeout=900s`,
  `kubectl -n cell-${canaryCells[0].name} rollout status deployment/gitlab-cell-${canaryCells[0].name}-webservice-default --timeout=300s`,
], needs: [{ job: "validate" }], rules: onlyMain });

// Stage 5: deploy-remaining (parallel matrix for non-canary cells)
export const deployRemaining = new Job({ stage: "deploy-remaining", image: helmImage,
  parallel: new Parallel({ matrix: remainingCells.map(c => ({ CELL_NAME: c.name })) }),
  script: [
    "helm upgrade --install gitlab-cell-$CELL_NAME ./gitlab-cell/ -n cell-$CELL_NAME -f values-$CELL_NAME.yaml --wait --timeout=900s",
    "kubectl -n cell-$CELL_NAME rollout status deployment/gitlab-cell-$CELL_NAME-webservice-default --timeout=300s",
  ],
  needs: [{ job: "deploy-canary" }], rules: onlyMain });

// Stage 6: register-runners — per-cell matrix job.
// Each cell creates a runner token in its own toolbox, stores it as a K8s secret
// in the cell namespace, then restarts that cell's runner Deployment.
// Token format glrt-cell_${CELL_ID}_ embeds the routable prefix the HTTP router
// uses for stateless CI job routing — no Topology Service lookup per dispatch.
export const registerRunners = new Job({ stage: "register-runners", image: gcloudImage,
  parallel: new Parallel({ matrix: cells.map(c => ({ CELL_NAME: c.name, CELL_ID: String(c.cellId) })) }),
  script: [
    "RUNNER_TOKEN=$(kubectl -n cell-$CELL_NAME exec deploy/gitlab-cell-$CELL_NAME-toolbox -- gitlab-rails runner \"puts Ci::Runner.create!(runner_type: :instance_type, registration_type: :authenticated_user, token_prefix: \\\"glrt-cell_${CELL_ID}_\\\").token\")",
    "kubectl -n cell-$CELL_NAME create secret generic $CELL_NAME-runner-token --from-literal=token=$RUNNER_TOKEN --dry-run=client -o yaml | kubectl apply -f -",
    "kubectl -n cell-$CELL_NAME rollout restart deploy/$CELL_NAME-runner",
    "kubectl -n cell-$CELL_NAME rollout status deploy/$CELL_NAME-runner --timeout=120s",
  ],
  needs: [{ job: "deploy-remaining" }], rules: onlyMain });

// Stage 7: smoke-test (E2E validation)
export const smokeTest = new Job({ stage: "smoke-test", image: gcloudImage, script: [
  "bash scripts/e2e-test.sh",
], needs: [{ job: "register-runners" }], rules: onlyMain });

// Stage 8: backup (scheduled — gitaly-backup per cell to GCS)
export const backupGitaly = new Job({ stage: "backup", image: gcloudImage,
  parallel: new Parallel({ matrix: cells.map(c => ({ CELL_NAME: c.name })) }),
  script: [
    "kubectl -n cell-$CELL_NAME exec statefulset/gitlab-cell-$CELL_NAME-gitaly -- gitaly-backup create --server-side --path gs://${GCP_PROJECT_ID}-${CELL_NAME}-artifacts/gitaly-backups/$(date +%Y%m%d)",
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
