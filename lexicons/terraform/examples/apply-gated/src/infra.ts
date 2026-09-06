/**
 * An existing Terraform root module, joined to a chant build — the same
 * shape `examples/getting-started/src/infra.ts` uses.
 *
 * Nothing is declared here. The entities come from `terraform.roots` in
 * `chant.config.ts` next door, parsed at build time by `buildRoots()` (TF001
 * passes: the root declares a `backend "local"`). The Op this example is
 * actually about — `TerraformApplyOp` with a gate and a rollback command —
 * lives in `apply-gated.op.ts`, beside this file, so the example build
 * discovers it and core's OPS012/OPS013 validate every step.
 *
 * It sat under `ops/` until chant #2101: those checks knew only about the
 * activities core itself declares a contract for, so `plan.out.planFile`
 * reaching the Show and Apply steps was flagged for the absence of a
 * contract terraform does in fact declare. They now merge the contracts each
 * configured lexicon contributes.
 */
export {};
