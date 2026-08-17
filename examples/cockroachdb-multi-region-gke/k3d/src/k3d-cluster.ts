// The smoke cluster, declared.
//
// `npm run build:k3d-cluster` emits the k3d.io/v1alpha5 config that
// `k3d cluster create --config` consumes, so the cluster's shape is typed
// source rather than a pile of flags in a shell script that drifts from it.
// The k3dUp step in ops/k3d-smoke.op.ts points at the emitted file.

import {
  Cluster,
  K3dOptions,
  K3sExtraArg,
  K3sOptions,
  Options,
} from "@intentius/chant-lexicon-k3d";
import { CLUSTER } from "./config";

export const smokeCluster = new Cluster({
  metadata: { name: CLUSTER },
  // Three CockroachDB nodes fit comfortably on one server node; agents would
  // only add container overhead for a test that does not schedule across them.
  servers: 1,
  agents: 0,
  options: new Options({
    k3d: new K3dOptions({ wait: true }),
    k3s: new K3sOptions({
      extraArgs: [
        // Nothing here is reached through an Ingress — the verify step talks
        // to the pods with `kubectl exec`.
        new K3sExtraArg({ arg: "--disable=traefik", nodeFilters: ["server:*"] }),
        new K3sExtraArg({ arg: "--disable=servicelb", nodeFilters: ["server:*"] }),
      ],
    }),
    // Left at chant's safe default (both false). The Op's k3dUp overrides
    // updateDefaultKubeconfig to true — later steps address the cluster by
    // context name, so the entry has to exist — but never
    // switchCurrentContext, so the smoke test does not move the current
    // context out from under a machine that also has three real GKE clusters
    // in its kubeconfig.
  }),
});
