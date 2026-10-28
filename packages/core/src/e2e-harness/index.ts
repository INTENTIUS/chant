/**
 * `@intentius/chant/e2e-harness` (chant#4587): the one e2e harness that
 * terragucci, plywood and sql-yodeler run their scenarios on, and that the
 * engines' claims cite (chant#4586 rulings B and D).
 *
 * - the stack: ./stack.ts's compose services and ./project/, the chant
 *   docker-lexicon project that wraps them, with every image in ./pins.ts
 * - the driver: ./driver.ts over ./ports.ts, with the real Forgejo
 *   (./forgejo.ts), floci's S3 (./bucket.ts) and the runner's jobs (./jobs.ts)
 * - the scenario format and its lint: ./scenario.ts, e2e-scenario/v1
 * - the claim row protocol: ./claim.ts, e2e-claim-row/v1 as an e2e-claim
 *   run record on the ledger, rendered as e2e-claims/v1
 * - the no-real-cloud wrapper: ./safe-run.ts
 *
 * A product on a published chant without this subpath feature-detects:
 * import it lazily, and use it when `E2E_HARNESS_FLOOR` is there.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { NEXT_RELEASE } from "../release-floors";

/** The first chant with the e2e harness. */
export const E2E_HARNESS_FLOOR = NEXT_RELEASE;

/**
 * The harness's chant docker-lexicon project, to `chant build <dir>/src
 * --lexicon docker`. It ships as source in the package's src/.
 */
export function harnessProjectDir(): string {
  const here = import.meta.dirname;
  const candidates = [join(here, "project"), join(here, "..", "..", "src", "e2e-harness", "project")];
  const found = candidates.find((d) => existsSync(join(d, "src", "compose.ts")));
  if (!found) throw new Error(`the e2e harness's compose project is not next to ${here}`);
  return found;
}

export * from "./pins";
export * from "./stack";
export * from "./ports";
export * from "./git";
export * from "./forgejo";
export * from "./bucket";
export * from "./jobs";
export * from "./reports";
export * from "./steps";
export * from "./scenario";
export * from "./driver";
export * from "./claim";
export * from "./safe-run";
export * from "./schemas/index";
