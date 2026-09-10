import { ConfigMap } from "@intentius/chant-lexicon-k8s";

/**
 * Decision point: **L5.3 / F-Eval-Ident** — `consts` is consulted before
 * `externals` and before the registered-name tables, so a local `const`
 * defeats a registered authoring helper or intrinsic of the same name.
 *
 * `output` is in `FOLDABLE_AUTHORING_HELPERS`
 * (`packages/core/src/fold/foldable-helpers.ts`) and `Ref` is a registered
 * call-form intrinsic in several lexicons. Neither is imported here; both are
 * ordinary local objects. Nothing about the SHAPE of `output.channel` or
 * `Ref.target` says which of the three tables should answer — the shape
 * classifier deliberately checks names only and stays permissive
 * (F-Div-Provenance) — so the fold/run agreement rests entirely on
 * resolution order.
 *
 * Get that order wrong and the two paths part company without a syntax error
 * anywhere: `fold()` would reduce `output` to a `{ __helper }` envelope whose
 * revival looks for an `output` among this file's imports, finds none, and
 * falls the file back to run; a bare eager intrinsic would be refused outright
 * (L3.17). Running has no such ambiguity — a local binding is the only
 * `output` in scope. The value that reaches the ConfigMap is the assertion:
 * `local-const`, not chant's helper.
 *
 * Differential mode: **byte-identical output**, and the file folds.
 */
const output = { channel: "local-const", note: "shadows the registered output() helper" };

const Ref = { target: "local-const", note: "shadows the registered Ref() intrinsic" };

export const shadowed = new ConfigMap({
  metadata: { name: "helper-name-shadowed" },
  data: {
    outputChannel: output.channel,
    outputNote: output.note,
    refTarget: Ref.target,
    refNote: Ref.note,
  },
});
