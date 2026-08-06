/**
 * k3d Op activities — resolved by the core activity registry when a project's
 * `chant.config.ts` lists the `k3d` lexicon. Relocated from the k8s lexicon
 * (chant #1410) so the local-cluster tooling lives with its product:
 *   - k3dUp / k3dDown — boot/tear down a local k3d cluster. Since #1411 the
 *     kubeconfig default is safe: the caller's default kubeconfig and current
 *     context are left alone unless explicitly requested, and `k3dUp` returns
 *     `{ context, kubeconfigPath? }` so later steps know what to talk to.
 *
 * The step builders (k3dUp, k3dDown) stay in core, re-exported from the
 * temporal Op-authoring barrel like the other core builders. The activities are
 * dependency-light — they shell out to the k3d CLI and do not import the k3d
 * declarable surface — so a Temporal worker loads them cheaply.
 */
export {
  k3dUp,
  k3dDown,
  k3dUpCommand,
  k3dDownCommand,
  k3dExistsCommand,
  k3dKubeconfigWriteCommand,
  k3dContextName,
} from "./k3d";
export type { K3dUpArgs, K3dDownArgs, K3dUpResult } from "./k3d";
