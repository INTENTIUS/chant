import { LexiconUpgradeOp } from "@intentius/chant-lexicon-temporal";

/**
 * cedar lexicon upgrade Op (epic #523 / #527, wired by #1650).
 *
 * The pinned constant is `CEDAR_WASM_VERSION` in lexicons/cedar/src/spec/pin.ts,
 * resolved against cedar-policy/cedar releases. Unlike the other pinned
 * lexicons, an upgrade here does not fetch a new spec — it swaps the grammar
 * implementation, and `generate()` asserts the Cedar *language* version before
 * emitting anything. A release that moves the language past 4.5 therefore
 * surfaces as a refusal in the regen step rather than as a silent surface
 * change, which is exactly the review this Op exists to trigger. Releases run
 * roughly monthly, so it will.
 *
 * Runs one-shot on the local executor via `chant run cedar-upgrade --local`.
 * The scheduled workflow (.github/workflows/lexicon-upgrade.yml) invokes it in
 * pull-request mode weekly; run it locally in report mode with:
 *   CHANT_UPGRADE_MODE=report chant run cedar-upgrade --local
 */
const mode = (process.env.CHANT_UPGRADE_MODE ?? "report") as "report" | "issue" | "pull-request";

export default LexiconUpgradeOp({ lexicon: "cedar", onFinding: mode }).op;
