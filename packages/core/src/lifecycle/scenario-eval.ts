/**
 * Pure evaluation of a plan scenario's `expect` clause against a `ChangeSet`
 * (#1292).
 *
 * `evaluateScenario` reads only what the caller hands it — a `ChangeSet` and
 * a `ScenarioExpect` — and does no I/O. Building the change set (reading a
 * fixture, replaying it in place of a live observation) is the CLI handler's
 * job (../cli/handlers/scenario.ts); this module is the part that stays
 * testable without a filesystem, a build, or a fixture.
 *
 * Built on the same primitives `chant lifecycle plan` already computes from:
 * `summarize` for counts, a filter over `cs.entries` for named deletes and
 * ownership, and `evaluateUnobservedGate` (./unobserved-gate.ts, #1568) for
 * the unobserved clause.
 */

import { summarize, type ChangeSet } from "./change-set";
import { evaluateUnobservedGate, type UnobservedGateFinding } from "./unobserved-gate";
import { unobservedReasonText } from "../observation";
import type { ScenarioDeleteExpectation, ScenarioExpect, ScenarioUnobservedPolicy } from "./scenario";

/**
 * One clause's verdict — always present in {@link ScenarioVerdict.checks}, in
 * declaration order, whether it passed or not. A scenario with no failing
 * clauses is legible too: every check that ran, and that it held.
 */
export interface ScenarioCheckResult {
  /** Which `expect` clause this is (`"noop"`, `"create"`, `"deletes"`, …). */
  clause: string;
  pass: boolean;
  /** Present when `pass` is false — what was expected vs what the plan proposes, naming resources for delete/ownership failures. */
  detail?: string;
}

/** The result of evaluating one scenario's `expect` against a change set. */
export interface ScenarioVerdict {
  pass: boolean;
  /** Every clause `expect` declared, evaluated — see {@link ScenarioCheckResult}. */
  checks: ScenarioCheckResult[];
}

/**
 * Evaluate `expect` against `cs`. Pure: reads `cs` and `expect`, computes
 * nothing else. Every clause present on `expect` is checked independently and
 * every one contributes to `checks`; `pass` is true only when all of them are.
 */
export function evaluateScenario(cs: ChangeSet, expect: ScenarioExpect): ScenarioVerdict {
  const counts = summarize(cs);
  const checks: ScenarioCheckResult[] = [];

  if (expect.noop) {
    const offenders = { create: counts.create, update: counts.update, delete: counts.delete };
    const clean = offenders.create === 0 && offenders.update === 0 && offenders.delete === 0;
    checks.push({
      clause: "noop",
      pass: clean,
      ...(clean
        ? {}
        : {
            detail:
              `expected noop (no create/update/delete) but the plan proposes ` +
              `${offenders.create} create, ${offenders.update} update, ${offenders.delete} delete — ` +
              nameList(cs, ["create", "update", "delete"]),
          }),
    });
  }

  for (const clause of ["create", "update", "delete"] as const) {
    const want = expect[clause];
    if (want === undefined) continue;
    const got = counts[clause];
    const pass = got === want;
    checks.push({
      clause,
      pass,
      ...(pass ? {} : { detail: `expected ${want} ${clause}, plan proposes ${got} — ${nameList(cs, [clause])}` }),
    });
  }

  if (expect.deletes) {
    checks.push(evaluateDeletesClause(cs, expect.deletes));
  }

  if (expect.unobserved !== undefined) {
    checks.push(evaluateUnobservedClause(cs, expect.unobserved));
  }

  return { pass: checks.every((c) => c.pass), checks };
}

/** Names (with type) of every entry matching one of `actions`, for a legible failure message. */
function nameList(cs: ChangeSet, actions: readonly string[]): string {
  const names = cs.entries
    .filter((e) => (actions as readonly string[]).includes(e.action))
    .map((e) => `${e.name}${e.type ? ` (${e.type})` : ""} [${e.action}]`);
  return names.length === 0 ? "(no matching entries)" : names.join(", ");
}

function evaluateDeletesClause(
  cs: ChangeSet,
  wanted: readonly ScenarioDeleteExpectation[],
): ScenarioCheckResult {
  const actualDeletes = cs.entries.filter((e) => e.action === "delete");
  const actualByName = new Map(actualDeletes.map((e) => [e.name, e] as const));
  const wantedNames = new Set(wanted.map((w) => w.name));
  const problems: string[] = [];

  for (const want of wanted) {
    const match = actualByName.get(want.name);
    if (!match) {
      problems.push(`"${want.name}" (ownership ${want.ownership}) — not proposed for delete`);
    } else if (match.ownership !== want.ownership) {
      problems.push(
        `"${want.name}" — expected ownership "${want.ownership}", plan proposes ownership "${match.ownership}"`,
      );
    }
  }
  for (const e of actualDeletes) {
    if (!wantedNames.has(e.name)) {
      problems.push(`"${e.name}"${e.type ? ` (${e.type})` : ""} [${e.ownership}] — deleted but not expected`);
    }
  }

  return {
    clause: "deletes",
    pass: problems.length === 0,
    ...(problems.length > 0 ? { detail: problems.join("; ") } : {}),
  };
}

function evaluateUnobservedClause(cs: ChangeSet, policy: ScenarioUnobservedPolicy): ScenarioCheckResult {
  // evaluateUnobservedGate enumerates every unobserved row regardless of
  // reason — "refuse" collects the full set to check against below. A
  // scenario's allow list names ENTITIES, not reasons (./scenario.ts's
  // ScenarioUnobservedPolicy doc explains why), so the gate's own reason-keyed
  // policy isn't reused for the pass/fail decision — only for the enumeration.
  const gate = evaluateUnobservedGate(cs, "refuse");
  const allowedNames = typeof policy === "object" ? new Set(policy.allow) : undefined;
  const unallowed = gate.findings.filter((f: UnobservedGateFinding) => !allowedNames?.has(f.name));

  return {
    clause: "unobserved",
    pass: unallowed.length === 0,
    ...(unallowed.length > 0
      ? {
          detail: unallowed
            .map((f) => `${f.name}${f.type ? ` (${f.type})` : ""} — ${unobservedReasonText(f.reason)}${f.detail ? `: ${f.detail}` : ""}`)
            .join(", "),
        }
      : {}),
  };
}
