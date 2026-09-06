import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-terraform";

/**
 * `terraform.roots` names the root module chant reads, exactly as
 * `examples/getting-started` does.
 *
 * `TerraformApplyOp` builds a `Chant::Op` entity, and that Op lives in
 * `src/apply-gated.op.ts`, so `chant dev check-lexicon`'s example-build check
 * discovers it and core's own OPS012/OPS013 validate every step. It sat under
 * `ops/`, out of the harness's reach, until chant #2101: those checks knew
 * only about the activities core itself declares a contract for, so
 * `plan.out.planFile` reaching the Show and Apply steps was flagged for the
 * absence of a contract terraform does in fact declare
 * (`src/op/activity-contracts.ts`, found by the same
 * `@intentius/chant-lexicon-<name>/op/...` convention the activity registry
 * uses).
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
