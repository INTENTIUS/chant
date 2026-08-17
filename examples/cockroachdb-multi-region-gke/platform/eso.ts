/**
 * External Secrets Operator, rendered into the build output.
 *
 * Every region's stack declares a ClusterSecretStore and two ExternalSecrets;
 * none of that reconciles until ESO itself is running in the cluster. That
 * install used to be three lines of shell in the deploy script —
 * `helm repo add`, `helm repo update`, `helm upgrade --install` — with two
 * consequences. `kubectl apply -f dist/` did not carry the operator, so the
 * build output was not the whole deployment; and no version was pinned
 * anywhere, so the deploy took whatever `helm repo update` had just fetched.
 * The chart went 0.x to 2.x in the meantime.
 *
 * `HelmRender` runs `helm template` at synth time and turns each rendered
 * manifest into a Declarable, so the operator lands in `dist/eso.yaml` like
 * anything else and the version is a line of source.
 *
 * This stack lives outside `src/` on purpose: rendering reaches for the `helm`
 * binary and, on a cold cache, the network. The four stacks under `src/` stay
 * pure synthesis, which is what the offline test corpus builds.
 *
 * Requires `helm` on PATH. The render is cached under
 * `~/.chant/helm-renders/<hash>`, keyed by repo, chart, version and values, so
 * only the first build reaches out.
 */

import { HelmRender } from "@intentius/chant-lexicon-helm";

/**
 * Bump deliberately: read the upstream release notes first, then change this
 * line. `helm search repo external-secrets/external-secrets --versions` lists
 * what is available.
 */
export const ESO_CHART_VERSION = "2.9.0";

export const externalSecrets = HelmRender({
  name: "external-secrets",
  repo: "https://charts.external-secrets.io",
  chart: "external-secrets",
  version: ESO_CHART_VERSION,
  namespace: "kube-system",
  values: {
    installCRDs: true,
    // The K8s service account each region's ClusterSecretStore points its
    // Workload Identity binding at. The GCP side is shared/iam.ts.
    serviceAccount: {
      name: "external-secrets-sa",
      annotations: {},
    },
    webhook: { replicaCount: 1 },
  },
});
