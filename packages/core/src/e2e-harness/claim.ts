/**
 * The claim row protocol (chant#4587), terragucci's: one claim, a plain run
 * that must pass, a BREAK=1 run that must be caught, one row. A row records
 * the product and its commit, the engine binary and version, the floci
 * digest, the date and both verdicts.
 *
 * Following the ledger ruling (chant#4551), the run is a ledger record: op
 * `e2e-claim`, the row as its `claim` outcome, one phase per arm. A
 * product's page reads e2e-claims/v1, rendered from those records with the
 * newest row per scenario and claim. Recording goes through ./safe-run.ts's
 * `recordClaimRow`, which refuses a run whose scan was not CLEAN.
 */
import type { OpRunRecord, OpRunRecordInput } from "../op/runtime";
import type { RunOrigin } from "../lifecycle/release-ledger";
import type { ArmRun, ClaimRun } from "./driver";
import { FLOCI_DIGEST } from "./pins";
import {
  E2E_CLAIMS_SCHEMA,
  E2E_CLAIM_ROW_SCHEMA,
  validateClaimRow,
  validateClaims,
  type BreakVerdict,
  type ClaimRow,
  type ClaimsDoc,
  type PlainVerdict,
  type Scenario,
} from "./schemas/index";

/** The op every claim run is recorded under. */
export const CLAIM_OP = "e2e-claim";

export interface ClaimRowInput {
  scenario: Pick<Scenario, "id" | "product" | "claim">;
  productCommit: string;
  engine: { binary: string; version: string };
  verdicts: { plain: PlainVerdict; break: BreakVerdict };
  /** When the run ended. */
  at: Date;
  /** The floci digest the stack ran. Default the harness's pin. */
  floci?: string;
  chant?: string;
  runUrl?: string;
}

/** A claim row, validated. A run's scan verdict is added when it is recorded. */
export function claimRow(i: ClaimRowInput): ClaimRow {
  const row: ClaimRow = {
    $schema: E2E_CLAIM_ROW_SCHEMA,
    contract: 1,
    product: i.scenario.product,
    productCommit: i.productCommit,
    scenario: i.scenario.id,
    claim: i.scenario.claim,
    engine: { binary: i.engine.binary, version: i.engine.version },
    floci: i.floci ?? FLOCI_DIGEST,
    ...(i.chant ? { chant: i.chant } : {}),
    date: i.at.toISOString().slice(0, 10),
    plain: i.verdicts.plain,
    break: i.verdicts.break,
    safeRun: "CLEAN",
    ...(i.runUrl ? { runUrl: i.runUrl } : {}),
  };
  const v = validateClaimRow(row);
  if (!v.ok) throw new Error(`the claim row for ${row.scenario} is not e2e-claim-row/v1: ${v.errors.join("; ")}`);
  return row;
}

/** Whether a row proves its claim: the plain run passed and the BREAK run was caught. */
export const rowHolds = (row: Pick<ClaimRow, "plain" | "break">): boolean => row.plain === "pass" && row.break === "caught";

const phaseOf = (run: ArmRun) => ({
  name: run.arm,
  // A phase fails when a step did, as the ledger reads phases; the arm's verdict is in the row.
  status: run.outcome === "held" ? ("ok" as const) : ("fail" as const),
  steps: run.steps.map((s) => ({
    fn: `${s.do}:${s.id}`,
    status: s.stopped ? ("fail" as const) : ("ok" as const),
    durationMs: 0,
    ...(s.stopped ? { error: `${s.stopped.outcome}: ${s.stopped.reason}` } : {}),
  })),
});

/**
 * The run record of one claim run (#4551): op `e2e-claim`, labels naming the
 * product, scenario and claim, the row as the `claim` outcome, and one phase
 * per arm with a step per scenario step. Status ok when the row holds.
 */
export function claimRunRecordInput(o: { row: ClaimRow; run: ClaimRun; env?: string; gitSha?: string; runOrigin?: RunOrigin }): OpRunRecordInput {
  return {
    op: CLAIM_OP,
    env: o.env ?? "local",
    started: o.run.plain.started,
    ended: o.run.break.ended,
    status: rowHolds(o.row) ? "ok" : "fail",
    labels: { Product: o.row.product, Scenario: o.row.scenario, Claim: o.row.claim },
    outcomes: { claim: o.row },
    phases: [phaseOf(o.run.plain), phaseOf(o.run.break)],
    ...(o.gitSha ? { gitSha: o.gitSha } : {}),
    ...(o.runOrigin ? { runOrigin: o.runOrigin } : {}),
  };
}

/** The rows on a ledger's e2e-claim records, oldest first. A record whose outcome is not a row is skipped. */
export function claimRowsOf(records: readonly OpRunRecord[]): ClaimRow[] {
  return records
    .filter((r) => r.op === CLAIM_OP)
    .slice()
    .sort((a, b) => a.ended.localeCompare(b.ended))
    .map((r) => r.outcomes.claim)
    .filter((c): c is ClaimRow => validateClaimRow(c).ok);
}

/**
 * e2e-claims/v1 for one product: its newest row per scenario and claim,
 * sorted by scenario then claim. Rows are recorded in order, so the last
 * one read for a pair is the newest.
 */
export function renderClaims(product: string, rows: readonly ClaimRow[]): ClaimsDoc {
  const newest = new Map<string, ClaimRow>();
  for (const row of rows) if (row.product === product) newest.set(`${row.scenario}\u0000${row.claim}`, row);
  const doc: ClaimsDoc = {
    $schema: E2E_CLAIMS_SCHEMA,
    contract: 1,
    product,
    rows: [...newest.values()].sort((a, b) => a.scenario.localeCompare(b.scenario) || a.claim.localeCompare(b.claim)),
  };
  const v = validateClaims(doc);
  if (!v.ok) throw new Error(`the rendered claims of ${product} are not e2e-claims/v1: ${v.errors.join("; ")}`);
  return doc;
}

/**
 * Whether an engine claim about `version` may count a row: only when the row
 * ran that version of that engine (chant#4586, the v0.28.0 against 0.31.0
 * split), and only when it holds.
 */
export function rowCountsFor(row: ClaimRow, engine: { binary: string; version: string }): boolean {
  const norm = (v: string) => v.replace(/^v/, "");
  return row.engine.binary === engine.binary && norm(row.engine.version) === norm(engine.version) && rowHolds(row);
}
