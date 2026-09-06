import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-terraform";

/**
 * `terraform.roots` names the root module chant reads, exactly as
 * `examples/getting-started` does. `temporal` is declared alongside it for
 * `ops/apply-gated.op.ts`'s real use (`chant run app-apply-gated --temporal`):
 * `TerraformApplyOp` builds a `Chant::Op` entity, and that Op lives outside
 * `src/` — `chant dev check-lexicon`'s example-build check only discovers
 * `src/`, the same layout `lexicons/aws/examples/lifecycle-reconcile-aws`
 * uses for its own ApplyOp/ReconcileOp. That split matters here specifically:
 * building the Op through the check harness would need `temporal` loaded to
 * serialize it at all, and doing so exercises temporal's own post-synth
 * checks (TMP012/TMP013) against every step's activity contract — checks
 * that only know about the activities temporal's own lexicon registers a
 * contract for, not a foreign lexicon's. That is a real, structural gap in
 * cross-lexicon contract validation, out of scope for this lexicon to patch.
 */
export default {
  lexicons: ["terraform", "temporal"],
  terraform: {
    binary: "terraform",
    roots: {
      app: { dir: "./terraform" },
    },
  },
} satisfies ChantConfig;
