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
import { isBehaviourRefusalReport, renderBehaviourRefusal, type BehaviourResult } from "../behaviour";
import { formatPerHour } from "../behaviour-delta";
import type {
  ScenarioCostExpectation,
  ScenarioDeleteExpectation,
  ScenarioExpect,
  ScenarioUnobservedPolicy,
} from "./scenario";

/**
 * What stands in for the engine's answer when a scenario carries a `cost`
 * clause (#2358): the fixture's `behaviour` block, or the reason there is
 * none. The handler resolves it from the same fixture every other clause
 * reads; this module only evaluates it.
 */
export type ScenarioBehaviourFixture =
  | { readonly result: BehaviourResult }
  | { readonly missing: string };

/**
 * One clause's verdict — always present in {@link ScenarioVerdict.checks}, in
 * declaration order, whether it passed or not. A scenario with no failing
 * clauses is legible too: every check that ran, and that it held.
 */
export interface ScenarioCheckResult {
  /** Which `expect` clause this is (`"noop"`, `"create"`, `"deletes"`, …). */
  clause: string;
  pass: boolean;
  /** Present when `pass` is false — what was expected vs what the plan
   * proposes, naming resources for delete/ownership failures. The `cost`
   * clause carries it on a pass too, saying which figure was bounded and
   * what the engine declined, so a passing bound is never read as a bound
   * over the whole estate when it was not. */
  detail?: string;
}

/** The result of evaluating one scenario's `expect` against a change set. */
export interface ScenarioVerdict {
  pass: boolean;
  /** Every clause `expect` declared, evaluated — see {@link ScenarioCheckResult}. */
  checks: ScenarioCheckResult[];
}

/**
 * Evaluate `expect` against `cs`. Pure: reads `cs`, `expect` and, for a
 * `cost` clause, the fixture's `behaviour` block handed over as `behaviour`;
 * computes nothing else. Every clause present on `expect` is checked
 * independently and every one contributes to `checks`; `pass` is true only
 * when all of them are.
 */
export function evaluateScenario(
  cs: ChangeSet,
  expect: ScenarioExpect,
  behaviour?: ScenarioBehaviourFixture,
): ScenarioVerdict {
  const counts = summarize(cs);
  const checks: ScenarioCheckResult[] = [];

  if (expect.noop) {
    // An effect receipt's fire (#1832) is a real proposed action — a
    // migration or seed job about to run — even though it never counts
    // toward the create/update/delete triad `buildChangeSet` classifies
    // ordinary resources into. `noop: true` claims the plan does nothing;
    // a pending effect fire is something, so it offends the claim exactly
    // like a create/update/delete would.
    const offenders = { create: counts.create, update: counts.update, delete: counts.delete, effect: counts.effect };
    const clean = offenders.create === 0 && offenders.update === 0 && offenders.delete === 0 && offenders.effect === 0;
    checks.push({
      clause: "noop",
      pass: clean,
      ...(clean
        ? {}
        : {
            detail:
              `expected noop (no create/update/delete/effect) but the plan proposes ` +
              `${offenders.create} create, ${offenders.update} update, ${offenders.delete} delete, ${offenders.effect} effect — ` +
              nameList(cs, ["create", "update", "delete", "effect"]),
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

  if (expect.cost !== undefined) {
    checks.push(evaluateCostClause(expect.cost, behaviour));
  }

  return { pass: checks.every((c) => c.pass), checks };
}

/**
 * The `cost` clause (#2358). Three refusals before any number is read, each
 * naming why, because the alternative to each is a bound that passes on
 * nothing:
 *
 *  - no `behaviour` block in the fixture — nothing was predicted;
 *  - the block is a refusal — the engine was absent, unreachable, out of
 *    credit, over quota, or refused a credential, and the fixture carries
 *    that refusal's own text;
 *  - the named entity is not in the fixture's figures — declined with a
 *    reason, or never asked about.
 *
 * The figure is then one of three, and the detail says which: the named
 * entity's own rate, the engine's stated total, or chant's sum over every
 * predicted entity when the engine states no total. The sum is chant's own
 * arithmetic and is labelled so; it also names every entity the engine
 * declined, because those are in the estate and not in the sum.
 */
function evaluateCostClause(
  bound: ScenarioCostExpectation,
  behaviour: ScenarioBehaviourFixture | undefined,
): ScenarioCheckResult {
  const fail = (detail: string): ScenarioCheckResult => ({ clause: "cost", pass: false, detail });

  if (behaviour === undefined || "missing" in behaviour) {
    return fail(
      `${behaviour?.missing ?? "the fixture carries no `behaviour` block"} — a cost bound is checked against the ` +
        "fixture's recorded prediction, and there is none. Record one on the snapshot, or drop the clause.",
    );
  }
  const result = behaviour.result;
  if (isBehaviourRefusalReport(result)) {
    return fail(
      `the fixture's prediction is a refusal (${result.refusal.cause}), and a bound cannot be checked against no ` +
        `figure: ${renderBehaviourRefusal(result.refusal, { color: false }).replace(/\n\s*/g, " ")}`,
    );
  }

  const declined = Object.entries(result.unpredicted ?? {}).map(
    ([name, u]) => `${name} (${u.reason}${u.detail ? `: ${u.detail}` : ""})`,
  );
  const declinedNote = declined.length > 0 ? `; ${declined.length} declined and not in the figure: ${declined.join(", ")}` : "";

  let perHour: number;
  let currency: string;
  let which: string;
  if (bound.entity !== undefined) {
    const figure = Object.prototype.hasOwnProperty.call(result.entities, bound.entity)
      ? result.entities[bound.entity]
      : undefined;
    if (!figure) {
      const hole = result.unpredicted?.[bound.entity];
      return fail(
        hole
          ? `"${bound.entity}" was declined by the engine (${hole.reason}${hole.detail ? `: ${hole.detail}` : ""}), so it has no figure to bound`
          : `"${bound.entity}" is in neither the fixture's figures nor its declined entities — the prediction never asked about it`,
      );
    }
    perHour = figure.cost.perHour;
    currency = figure.cost.currency;
    which = `${bound.entity}'s own rate (${figure.provenance.engine} ${figure.provenance.version}, ${figure.provenance.tolerance}, ${figure.provenance.basis})`;
  } else if (result.meta.total) {
    perHour = result.meta.total.perHour;
    currency = result.meta.total.currency;
    which = `the engine's own estate total (${result.meta.engine} ${result.meta.version})${declinedNote}`;
  } else {
    const names = Object.keys(result.entities);
    const currencies = new Set(names.map((n) => result.entities[n].cost.currency));
    if (currencies.size > 1) {
      return fail(
        `the engine states no total and the entities are priced in ${[...currencies].sort().join(", ")} — chant converts ` +
          "nothing, so there is no one sum to bound",
      );
    }
    if (names.length === 0) {
      return fail(`the engine states no total and predicted no entity${declinedNote} — nothing to bound`);
    }
    perHour = names.reduce((sum, n) => sum + result.entities[n].cost.perHour, 0);
    currency = [...currencies][0];
    which = `chant's own sum over ${names.length} predicted entit${names.length === 1 ? "y" : "ies"} (the engine states no total)${declinedNote}`;
  }

  const level = result.meta.at.traffic;
  if (currency !== bound.currency) {
    return fail(
      `the bound is in ${bound.currency} and the figure is ${formatPerHour(perHour)} ${currency}/hour at "${level}" — ` +
        `chant converts nothing; read from ${which}`,
    );
  }
  const pass = perHour <= bound.maxPerHour;
  const detail =
    `${pass ? "" : "exceeded: "}${formatPerHour(perHour)} ${currency}/hour at "${level}" against a bound of ` +
    `${formatPerHour(bound.maxPerHour)} ${bound.currency}/hour; read from ${which}`;
  return { clause: "cost", pass, detail };
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
