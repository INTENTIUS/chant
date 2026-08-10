/**
 * API group → `K8s::{Namespace}::{Kind}` namespace segment — the ONE copy.
 *
 * Four surfaces build entityTypes from a group string: CRD codegen
 * (`crd/parser.ts`), the swagger pass (`spec/parse.ts`), live discovery
 * (`describe-resources.ts` via `gvkToTypeName`), and YAML import
 * (`import/parser.ts`). Until #1628 each had its own copy of the rule and only
 * CRD codegen consulted the overrides, so a Flux Kustomization arriving through
 * a kustomize root or `chant import` was typed `K8s::Kustomize::Kustomization`
 * — a name that matches nothing in operations.json (NOT-OBSERVED live) and
 * nothing downstream that dispatches on kind. Every path resolves here now;
 * the declared, rendered, imported and discovered spellings of a kind cannot
 * skew.
 */

/**
 * Group names whose first segment doesn't yield the conventional namespace.
 * "argoproj.io" → "Argo" (not "Argoproj") to match the Argo CD vocabulary
 * and the ArgoAppFor / ArgoAppSetForRegions composites.
 *
 * The Flux toolkit spreads across five `*.toolkit.fluxcd.io` groups plus the
 * Flux Operator's `fluxcd.controlplane.io`; all six collapse to a single `Flux`
 * namespace so a GitRepository and a Kustomization read as `K8s::Flux::*`
 * siblings rather than scattering to Source / Kustomize / Helm / Notification /
 * Image / Fluxcd. (`helm.toolkit.fluxcd.io` → `Helm` would also collide
 * confusingly with the separate helm lexicon.)
 *
 * KubeMicroVM's `lambda.aws.amazon.com` would take `Lambda` by the
 * first-segment rule, which reads as AWS Lambda proper and would sit
 * confusingly beside the aws lexicon's real Lambda functions. These are
 * Kubernetes CRs belonging to a community operator, so they take the
 * operator's own name. `MicroVM` alone was the alternative and was rejected
 * for stuttering: `K8s::MicroVM::MicroVM`.
 *
 * Note the official AWS controller uses a different group,
 * `lambdamicrovms.services.k8s.aws`, so it can coexist here and will want its
 * own entry rather than sharing this one.
 */
export const GROUP_NAMESPACE_OVERRIDES: Record<string, string> = {
  "argoproj.io": "Argo",
  "source.toolkit.fluxcd.io": "Flux",
  "kustomize.toolkit.fluxcd.io": "Flux",
  "helm.toolkit.fluxcd.io": "Flux",
  "notification.toolkit.fluxcd.io": "Flux",
  "image.toolkit.fluxcd.io": "Flux",
  "fluxcd.controlplane.io": "Flux",
  "lambda.aws.amazon.com": "KubeMicroVM",
  // CNPG and its barman-cloud plugin ship under two groups but are one thing to
  // an author: a Cluster's `plugins[]` names an ObjectStore. The first-segment
  // rule would scatter them into `Postgresql` and `Barmancloud`.
  "postgresql.cnpg.io": "Cnpg",
  "barmancloud.cnpg.io": "Cnpg",
  // Not `Secrets`: `K8s::Secrets::InfisicalSecret` reads like a core Secret,
  // and `K8s::Core::Secret` is right there to be confused with.
  "secrets.infisical.com": "Infisical",
  // k3s's bundled controllers ship under two groups but are one thing to an
  // author — the k3s auto-deploy surface. The first-segment rule would give
  // `K8s::Helm::HelmChart`, which reads like it belongs to the helm lexicon,
  // and would split HelmChart from the Addon that tracks its deployment.
  "helm.cattle.io": "K3s",
  "k3s.cattle.io": "K3s",
};

/**
 * Normalize an API group to its PascalCase namespace segment.
 * "" → "Core", overrides first ("argoproj.io" → "Argo"), then the first
 * dot-segment kebab→PascalCased: "cert-manager.io" → "CertManager",
 * "rbac.authorization.k8s.io" → "Rbac", "apps" → "Apps".
 */
export function namespaceSegmentForGroup(group: string): string {
  if (!group || group === "") return "Core";
  const override = GROUP_NAMESPACE_OVERRIDES[group];
  if (override) return override;
  const firstSegment = group.split(".")[0];
  return firstSegment
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}
