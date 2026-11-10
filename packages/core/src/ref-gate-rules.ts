/**
 * `@intentius/chant/ref-gate-rules` (#4913): the ref gate's rules (#4867)
 * for a product to read, so it needs no code of its own for the policy in
 * `.chant/trust.json`'s `refs`.
 *
 * {@link refGateRulesAt} reads the rules for one ref from the policy at
 * base, as `chant workspace ref-gate` does: whether a rule matches, the
 * checks it needs evidence for, and the status the gate's status job sets.
 * An apply before merge passes that status as `require` to chant's requires
 * checks (`checkPrRequires` in `@intentius/chant/pr-requires`), so `checks`
 * waits for the gate's status rather than passing before the job posted it.
 * A forge check passes it as `refGateStatus` to `pipelineContract`;
 * {@link refGateStatusFor} reads it for the default branch, as
 * `chant ci forge-check --ref-gate-status` does.
 */

export {
  REF_GATE_STATUS,
  refGateRulesAt,
  refGateStatusFor,
  refPatternRegExp,
  rulesFor,
  type RefGateRules,
} from "./workspace/trust/ref-gate";
export type { RefRule } from "./workspace/trust/policy";
export { REF_GATE_PIECES_FLOOR } from "./release-floors";
