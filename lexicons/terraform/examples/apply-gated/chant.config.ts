import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-terraform";

/**
 * `terraform.roots` names the root module chant reads, exactly as
 * `examples/getting-started` does.
 *
 * `TerraformApplyOp` builds a `Chant::Op` entity, and that Op lives outside
 * `src/` — `chant dev check-lexicon`'s example-build check only discovers
 * `src/`, the same layout `lexicons/aws/examples/lifecycle-reconcile-aws`
 * uses for its own ApplyOp/ReconcileOp. `chant run app-apply-gated`
 * discovers `ops/` on its own.
 */
export default {
  lexicons: ["terraform"],
  terraform: {
    binary: "terraform",
    roots: {
      app: { dir: "./terraform" },
    },
  },
} satisfies ChantConfig;
