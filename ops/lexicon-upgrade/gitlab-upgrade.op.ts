import { LexiconUpgradeOp } from "@intentius/chant-lexicon-temporal";

/**
 * gitlab lexicon upgrade Op (epic #523 / #527).
 *
 * Runs one-shot on the local executor via `chant run gitlab-upgrade --local`.
 * The scheduled workflow (.github/workflows/lexicon-upgrade.yml) invokes it in
 * pull-request mode weekly; run it locally in report mode with:
 *   CHANT_UPGRADE_MODE=report chant run gitlab-upgrade --local
 *
 * onFinding is read from CHANT_UPGRADE_MODE so the same Op definition serves
 * both the local report loop and the CI pull-request loop.
 */
const mode = (process.env.CHANT_UPGRADE_MODE ?? "report") as "report" | "issue" | "pull-request";

export default LexiconUpgradeOp({ lexicon: "gitlab", onFinding: mode }).op;
