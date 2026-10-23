/**
 * The requires checks of an apply before merge (#4301, ws-106): the pull
 * request is approved, mergeable, undiverged and its checks passed, each
 * asked of the forge through its {@link PrForge} method. All four must pass.
 *
 * The checks are terragucci's `apply.requires` (comment-apply.ts:781-860 at
 * INTENTIUS/terragucci e6cb431). A product may leave one out with `only`
 * (#4336); chant's own `pr-apply --before-merge` passes no `only`, so it asks
 * all four, as ws-106 requires. A check the
 * forge has not settled, such as GitHub working out whether a pull request
 * can merge, is asked again a few times before it counts as unmet.
 *
 * Like ./pr-forge.ts this imports nothing beyond it, so a product bundles it
 * without the TypeScript toolchain.
 */
import type { PrApproverFilter, PrExcludedApprover, PrForge, PrRequireResult } from "./pr-forge";

/** The four checks, in the order they run and the report lists them. */
export const PR_APPLY_REQUIRES = ["approved", "mergeable", "undiverged", "checks"] as const;

export type PrApplyRequire = (typeof PR_APPLY_REQUIRES)[number];

/** One check as the pull-request report's `beforeMerge.requires` holds it. */
export interface PrRequireOutcome extends PrRequireResult {
  name: PrApplyRequire;
  /** `approved` only (#4287): the logins that counted, as {@link PrApprovalResult} gives them. */
  approvers?: string[];
  /** `approved` only (#4287): the logins left out, each with why. */
  excluded?: PrExcludedApprover[];
}

export interface PrRequiresOptions {
  /**
   * The checks to ask (#4336). One left out passes with the reason "not
   * required" and makes no forge call. Default: all four.
   */
  only?: readonly PrApplyRequire[];
  /** Who counts as an approver for `approved` (#4337). Default: anyone other than the authors. */
  approvers?: PrApproverFilter;
  /** Status names the `checks` require leaves out: the apply's own. */
  ignore?: readonly string[];
  /** How many times a pending check is asked in all. Default 5. */
  reads?: number;
  /** The wait between reads. Default 3 seconds. */
  wait?: (ms: number) => Promise<void>;
}

const READS = 5;
const WAIT_MS = 3000;

/**
 * Ask `forge` each of the four checks for pull request `pr` at `head`. A
 * forge client without a method, or a call that throws, gives an unmet
 * check with the reason, so nothing applies on a check nobody made.
 */
export async function checkPrRequires(forge: PrForge, pr: number, head: string, opts: PrRequiresOptions = {}): Promise<PrRequireOutcome[]> {
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const reads = Math.max(1, opts.reads ?? READS);
  const ask: Record<PrApplyRequire, (() => Promise<PrRequireResult>) | undefined> = {
    approved: forge.prApproved ? () => forge.prApproved!(pr, head, opts.approvers) : undefined,
    mergeable: forge.prMergeable ? () => forge.prMergeable!(pr, head) : undefined,
    undiverged: forge.prUndiverged ? () => forge.prUndiverged!(pr, head) : undefined,
    checks: forge.prChecksPassed ? () => forge.prChecksPassed!(pr, head, opts.ignore ?? []) : undefined,
  };
  const out: PrRequireOutcome[] = [];
  const asked = new Set<PrApplyRequire>(opts.only ?? PR_APPLY_REQUIRES);
  for (const name of PR_APPLY_REQUIRES) {
    if (!asked.has(name)) {
      out.push({ name, passed: true, reason: "not required" });
      continue;
    }
    const call = ask[name];
    if (!call) {
      out.push({ name, passed: false, reason: `this ${forge.kind} client cannot say` });
      continue;
    }
    let result: PrRequireResult;
    for (let read = 1; ; read++) {
      try {
        result = await call();
      } catch (err) {
        result = { passed: false, reason: `could not ask ${forge.kind}: ${err instanceof Error ? err.message : String(err)}` };
      }
      if (result.passed || !result.pending || read >= reads) break;
      await wait(WAIT_MS);
    }
    out.push({ name, ...result });
  }
  return out;
}

/** The unmet checks as one line, or null when all four passed. */
export function unmetRequires(outcomes: readonly PrRequireOutcome[]): string | null {
  const unmet = outcomes.filter((o) => !o.passed);
  if (unmet.length === 0) return null;
  return unmet.map((o) => `${o.name}: ${o.reason}`).join("; ");
}
