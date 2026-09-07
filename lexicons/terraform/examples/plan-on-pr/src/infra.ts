/**
 * The estate is the `terraform/` directory beside this one, joined to the
 * build through `terraform.roots` in `chant.config.ts`, the same arrangement
 * `examples/getting-started` explains at length.
 *
 * Nothing is declared here. The two Ops this example is about are
 * `app-plan.op.ts` and `app-apply.op.ts` next to this file, and what makes
 * them a pair is not anything in the source: it is the trigger each one is given
 * when `generateOpsPipeline` renders it, `pull_request` for the plan and
 * `push` for the apply. `../../examples.test.ts` is the copyable form of
 * that call.
 */
export {};
