// The deploy verb both the CI job and a laptop run share:
//
//   chant run preview-apply                          # env from CHANT_ENV, default "local"
//   chant run preview-apply --param env=pr-42        # an explicit PR instance
//
// ApplyOp is build → plan → apply on the local Op executor (no Temporal
// server): `npm run build` renders dist/manifests.yaml for the resolved env,
// the plan phase live-diffs it, and the apply is a Kubernetes server-side
// apply as field manager `chant:pr-preview`. Deletes are owned-only — scoped
// to the ownership marker — so a preview apply can never remove anything a
// PR build did not create.

import { ApplyOp } from "@intentius/chant-lexicon-temporal";
import { params } from "@intentius/chant/params";

const apply = ApplyOp({
  name: "preview-apply",
  env: params.env as string,
  target: "kubectl",
  path: ".",
  output: "dist/manifests.yaml",
  delete: "owned-only",
});

export default apply.op;
