// L4 — the lifecycle dial, position 3: authoritative (code → cloud).
//
// ApplyOp builds, plans, and applies your declarations to the cluster via the
// target's native mechanism (here kubectl). Deletes are owned-only: the prune is
// scoped to the chant ownership marker, so a resource you didn't declare is never
// touched. This is the authoritative end of the dial — chant pushes source into
// the live system. chant hosts no state file; authority stays with kubectl.
//
//   chant run apply
import { ApplyOp } from "@intentius/chant-lexicon-temporal";

const apply = ApplyOp({
  name: "apply",
  env: "local",
  target: "kubectl",
  path: "examples/getting-started",
  output: "examples/getting-started/k8s.yaml",
  delete: "owned-only",
});

export default apply.op;
