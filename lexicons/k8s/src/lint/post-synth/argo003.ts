/**
 * ARGO003: Application.spec.destination must reference a registered cluster
 *
 * An Argo `Application` targets a cluster via `spec.destination.server` (an API
 * server URL) or `spec.destination.name` (a registered cluster name). External
 * clusters are registered with a Secret labelled
 * `argocd.argoproj.io/secret-type: cluster`. The in-cluster target
 * (`https://kubernetes.default.svc` / name `in-cluster`) is always available.
 * A destination that names neither a registered cluster nor the in-cluster
 * target won't resolve at sync time.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import {
  allManifests,
  manifestsOfKind,
  isClusterSecret,
  secretField,
  IN_CLUSTER_SERVER,
  IN_CLUSTER_NAME,
} from "./argo-helpers";

export const argo003: PostSynthCheck = {
  id: "ARGO003",
  description: "Application.spec.destination must reference a registered cluster or the in-cluster target",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const manifests = allManifests(ctx);

    const registeredServers = new Set<string>([IN_CLUSTER_SERVER]);
    const registeredNames = new Set<string>([IN_CLUSTER_NAME]);
    for (const secret of manifests.filter(isClusterSecret)) {
      const server = secretField(secret, "server");
      if (server) registeredServers.add(server);
      const name = secretField(secret, "name") ?? secret.metadata?.name;
      if (typeof name === "string") registeredNames.add(name);
    }

    for (const app of manifestsOfKind(manifests, "Application")) {
      const name = app.metadata?.name ?? "Application";
      const destination = app.spec?.destination as
        | { server?: unknown; name?: unknown }
        | undefined;

      if (!destination || (destination.server === undefined && destination.name === undefined)) {
        diagnostics.push({
          checkId: "ARGO003",
          severity: "error",
          message: `Application "${name}" has no spec.destination.server or spec.destination.name — Argo cannot resolve a target cluster.`,
          entity: name,
          lexicon: "k8s",
        });
        continue;
      }

      if (typeof destination.server === "string" && !registeredServers.has(destination.server)) {
        diagnostics.push({
          checkId: "ARGO003",
          severity: "error",
          message: `Application "${name}" targets cluster server "${destination.server}", which is not registered. Register it with a cluster Secret (label argocd.argoproj.io/secret-type=cluster) or use the in-cluster target.`,
          entity: name,
          lexicon: "k8s",
        });
        continue;
      }

      if (typeof destination.name === "string" && !registeredNames.has(destination.name)) {
        diagnostics.push({
          checkId: "ARGO003",
          severity: "error",
          message: `Application "${name}" targets cluster name "${destination.name}", which is not registered. Register it with a cluster Secret or use the in-cluster target.`,
          entity: name,
          lexicon: "k8s",
        });
      }
    }

    return diagnostics;
  },
};
