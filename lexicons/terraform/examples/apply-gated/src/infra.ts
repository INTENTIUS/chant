/**
 * An existing Terraform root module, joined to a chant build — the same
 * shape `examples/getting-started/src/infra.ts` uses.
 *
 * Nothing is declared here. The entities come from `terraform.roots` in
 * `chant.config.ts` next door, parsed at build time by `buildRoots()` (TF001
 * passes: the root declares a `backend "local"`). The Op this example is
 * actually about — `TerraformApplyOp` with a gate and a rollback command —
 * lives in `ops/apply-gated.op.ts`, not here: it is a `Temporal::Op` entity,
 * and `chant dev check-lexicon`'s example-build check discovers only `src/`,
 * so putting a foreign-lexicon Op here would need `temporal` loaded for this
 * check alone and would run temporal's own post-synth checks against it —
 * checks that validate a step's activity contract, and know only about the
 * activities temporal's own lexicon registers one for. `ops/` is where a
 * project's `*.op.ts` files live regardless: `chant run` finds them there,
 * same as `lexicons/aws/examples/lifecycle-reconcile-aws`.
 */
export {};
