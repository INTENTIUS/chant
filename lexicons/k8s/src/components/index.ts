/**
 * The k8s lexicon's component/release surface: the `kubectl-apply` capability,
 * its typed step-builder, and the `k8sCapabilityPlugin` core loads when a
 * project declares `lexicons: ["k8s"]` (#1495). Component authors import the
 * builders from here (`@intentius/chant-lexicon-k8s/components`), the way AWS
 * verbs come from `@intentius/chant-lexicon-aws/components`.
 *
 * Everything exported here is on the build path (#1074): nothing may
 * statically import the Kubernetes API client chain (`../op/activities/*`,
 * `../kube/*`) — `kubectl-apply.ts` reaches its applier by dynamic import
 * inside `run()`, and this module must stay that clean.
 */

export { k8sCapabilityPlugin, K8S_VERB_FAMILIES } from "./capability-plugin";
export * from "./builders";
export {
  kubectlApplyCapability,
  createKubectlApplyCapability,
  type KubectlApplyInput,
  type KubectlApplyOutcome,
} from "./kubectl-apply";
export {
  kustomizeApplyCapability,
  createKustomizeApplyCapability,
  renderCommand,
  type KustomizeApplyInput,
  type KustomizeApplyOutcome,
} from "./kustomize-apply";
