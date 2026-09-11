/**
 * The predicted delta between two behaviour results, and how it is shown
 * (#2358, contract #2356).
 *
 * `behaviour.ts` ships the invariant and deliberately not the presentation:
 * {@link compareFigures} says on which axes two figures fail to be a delta of
 * like things, and binds every consumer to mark such a pair wherever it is
 * shown. This module is the consumer. It takes the base side and the head
 * side of a pull request as two {@link BehaviourResult}s and produces one
 * finding, under four rules that are the contract's and #2358's rather than
 * this file's:
 *
 *  1. A whole-run refusal on either side is a finding that says **no
 *     prediction**, with the refusal's own text and remedy. Never a delta and
 *     never a partial one: the five refusal causes are the engine being
 *     absent, unreachable, out of credit, over quota, or a credential in the
 *     request, and none of them is a statement about the estate.
 *  2. A delta is computed only over entities predicted on **both** sides. An
 *     entity declined on either side — `unpredicted`, whatever the reason —
 *     is a row in the finding saying so, not an absent row and not a zero. An
 *     estate that gained an unmapped kind between the two runs did not gain a
 *     cost, and a finding that read it as one would be the faked number the
 *     epic forbids.
 *  3. Before any two figures are differenced, {@link compareFigures} runs. A
 *     non-empty mismatch set means the pair is **marked** with every label in
 *     it, in {@link FIGURE_MISMATCHES}' display order, and no number is
 *     subtracted. `modeled` minus `validated` is not a change in the estate.
 *  4. Every figure shown carries its provenance — engine, version, tolerance,
 *     basis — and a rate is rendered as a rate: so much per hour, at the
 *     stated traffic level, never an amount.
 *
 * Resilience has a fifth rule, from #2360's third comment: a verdict is
 * computed over the graph the engine was handed, and the declared path hands
 * over reference edges with no containment. When either side's
 * `meta.edgeCoverage` is `partial` or `unknown`, the two verdicts were reached
 * over graphs of different completeness, and the finding shows each side's
 * verdict and says why they are not compared rather than drawing an arrow
 * between them.
 *
 * Pure: no I/O, no clock, no environment. The Op activity that posts the
 * result (`./op/activities/predict-behaviour.ts`) is where the sides come
 * from.
 */

import {
  FIGURE_MISMATCHES,
  compareFigures,
  isBehaviourRefusalReport,
  isBehaviourResult,
  isBehaviourUnpredictedReason,
  renderBehaviourRefusal,
  validateBehaviourBlock,
  validateEdgeCoverage,
  type BehaviourEdgeCoverage,
  type BehaviourProvenance,
  type BehaviourRefusal,
  type BehaviourReport,
  type BehaviourReportMeta,
  type BehaviourResult,
  type FigureMismatch,
  type PredictedBehaviour,
  type PredictedRate,
  type UnpredictedEntity,
} from "./behaviour";

/* -------------------------------------------------------------------------- */
/* Validating a result on arrival                                             */
/* -------------------------------------------------------------------------- */

/**
 * Hold a {@link BehaviourResult} to the contract, on arrival.
 *
 * `behaviourReport` checks a report as the ordinary route builds it, and its
 * own doc says plainly that this is a check and not a proof: the report type
 * is a plain interface, `isBehaviourResult` accepts a hand-built one, and a
 * lexicon calling the builder with `entityNames: Object.keys(entities)`
 * self-certifies. A consumer that needs the guarantee runs this instead, with
 * the names it asked about, and the two consumers that need it are the delta
 * (each side arrives from a plugin) and a scenario's fixture (the block
 * arrives from JSON on disk).
 *
 * Throws, naming what is wrong. The refusals are the builder's, applied to a
 * result rather than to its parts: an entity in neither map or in both, a
 * figure for a name nobody asked about, a block priced at a level the run did
 * not ask for, an unpredicted reason outside the closed set, an edge-coverage
 * claim that names no gap, and any block failing `validateBehaviourBlock`. A
 * refusal arm is held to having a legal cause and a non-empty reason and
 * remedy, since those two strings are what a consumer prints.
 */
export function validateBehaviourResult(result: unknown, askedFor: readonly string[]): BehaviourResult {
  if (!isBehaviourResult(result)) {
    throw new Error(
      "behaviour result is neither a report nor a refusal: expected `behaviour: \"v1\"` with either " +
        "`refusal` or both `meta` and `entities`.",
    );
  }
  if (isBehaviourRefusalReport(result)) {
    const r = result.refusal;
    if (!isBehaviourUnpredictedReason(r.cause)) {
      throw new Error(`behaviour refusal carries the cause ${JSON.stringify(r.cause)}, which is not a legal reason.`);
    }
    if (typeof r.reason !== "string" || r.reason.trim() === "") {
      throw new Error("behaviour refusal states no reason — the sentence a consumer prints is missing.");
    }
    if (typeof r.remedy !== "string" || r.remedy.trim() === "") {
      throw new Error("behaviour refusal states no remedy — a refusal exists to be acted on.");
    }
    return result;
  }

  const report = result;
  validateEdgeCoverage(report.meta.edgeCoverage);
  if (typeof report.meta.at?.traffic !== "string" || report.meta.at.traffic.trim() === "") {
    throw new Error("behaviour report states no traffic level in meta.at — a figure without its question is a bill in waiting.");
  }
  const asked = new Set(askedFor);
  const unpredicted = report.unpredicted ?? {};
  const holes = new Set(Object.keys(unpredicted));

  for (const name of Object.keys(report.entities)) {
    if (holes.has(name)) throw new Error(`behaviour report names "${name}" as both predicted and unpredicted.`);
    if (!asked.has(name)) {
      throw new Error(`behaviour report carries a figure for "${name}", which was not asked about.`);
    }
    validateBehaviourBlock(name, report.entities[name]);
    if (report.entities[name].at.traffic !== report.meta.at.traffic) {
      throw new Error(
        `behaviour report priced "${name}" at ${JSON.stringify(report.entities[name].at.traffic)} in a run ` +
          `whose meta.at.traffic is ${JSON.stringify(report.meta.at.traffic)}.`,
      );
    }
  }
  for (const name of holes) {
    if (!asked.has(name)) throw new Error(`behaviour report names "${name}" unpredicted, and it was not asked about.`);
    if (!isBehaviourUnpredictedReason(unpredicted[name]?.reason)) {
      throw new Error(
        `behaviour report gives "${name}" the reason ${JSON.stringify(unpredicted[name]?.reason)}, which is not a legal one.`,
      );
    }
  }
  const missing = askedFor.filter(
    (name) => !Object.prototype.hasOwnProperty.call(report.entities, name) && !holes.has(name),
  );
  if (missing.length > 0) {
    throw new Error(
      `behaviour report gives no verdict at all for ${missing.map((n) => `"${n}"`).join(", ")}. Every entity ` +
        "asked about lands in `entities` or in `unpredicted`; there is no third position.",
    );
  }
  return report;
}

/* -------------------------------------------------------------------------- */
/* The delta                                                                  */
/* -------------------------------------------------------------------------- */

/** One side of the delta: the result, and what to call it in the finding. */
export interface BehaviourDeltaSide {
  /** `base` or `head`, or whatever the caller calls the two sides. */
  label: string;
  /** What the side was predicted from — a branch, a ref, a pull request. Free text. */
  ref?: string;
  result: BehaviourResult;
}

/** Why a row carries no plain difference. */
export type BehaviourDeltaRowKind =
  /** Predicted on both sides and comparable: `deltaPerHour` is a difference in the estate. */
  | "comparable"
  /** Predicted on both sides and not a delta of like things: `mismatches` says on which axes. */
  | "marked"
  /** Declined on one side or both: `baseDeclined`/`headDeclined` say why. */
  | "declined"
  /** Present on the base side only — removed by the change. */
  | "only-base"
  /** Present on the head side only — added by the change. */
  | "only-head";

/** One entity's row in the finding. */
export interface BehaviourDeltaRow {
  name: string;
  /** Declared entity type, when either side knows it. */
  type?: string;
  kind: BehaviourDeltaRowKind;
  base?: PredictedBehaviour;
  head?: PredictedBehaviour;
  baseDeclined?: UnpredictedEntity;
  headDeclined?: UnpredictedEntity;
  /** Every axis the pair disagrees on, in display order. Non-empty exactly when `kind` is `marked`. */
  mismatches?: FigureMismatch[];
  /** `head.cost.perHour - base.cost.perHour`, present exactly when `kind` is `comparable`. */
  deltaPerHour?: number;
  /** The currency both comparable figures share. */
  currency?: string;
}

/** chant's own sum of the comparable rows' deltas, per currency, labelled as such wherever it is shown. */
export interface ComparableDeltaSum {
  currency: string;
  perHour: number;
  /** How many comparable pairs the sum is over. */
  pairs: number;
}

/** A finding with figures on both sides. */
export interface BehaviourDeltaReport {
  kind: "delta";
  base: { label: string; ref?: string; meta: BehaviourReportMeta };
  head: { label: string; ref?: string; meta: BehaviourReportMeta };
  /** Every entity either side named, one row each, sorted by name. */
  rows: BehaviourDeltaRow[];
  /** The comparable rows' deltas summed by chant, per currency. Empty when no row is comparable. */
  sums: ComparableDeltaSum[];
  /**
   * Whether the two sides' resilience verdicts were reached over graphs of the
   * same completeness — both `meta.edgeCoverage.verdict === "complete"`. When
   * false the finding shows each verdict and does not compare them.
   */
  resilienceComparable: boolean;
}

/** A finding with no figures, because one side or both refused. */
export interface BehaviourDeltaRefused {
  kind: "no-prediction";
  base: { label: string; ref?: string; refusal?: BehaviourRefusal };
  head: { label: string; ref?: string; refusal?: BehaviourRefusal };
}

export type BehaviourDelta = BehaviourDeltaReport | BehaviourDeltaRefused;

/** Code-unit order, so two runs on two machines sort the rows the same way. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function has(map: Record<string, unknown> | undefined, key: string): boolean {
  return map !== undefined && Object.prototype.hasOwnProperty.call(map, key);
}

/**
 * Compute the delta. Pure, and never subtracts two figures it has not first
 * put through {@link compareFigures}.
 */
export function behaviourDelta(base: BehaviourDeltaSide, head: BehaviourDeltaSide): BehaviourDelta {
  const baseRefused = isBehaviourRefusalReport(base.result);
  const headRefused = isBehaviourRefusalReport(head.result);
  if (baseRefused || headRefused) {
    return {
      kind: "no-prediction",
      base: {
        label: base.label,
        ...(base.ref ? { ref: base.ref } : {}),
        ...(baseRefused ? { refusal: (base.result as { refusal: BehaviourRefusal }).refusal } : {}),
      },
      head: {
        label: head.label,
        ...(head.ref ? { ref: head.ref } : {}),
        ...(headRefused ? { refusal: (head.result as { refusal: BehaviourRefusal }).refusal } : {}),
      },
    };
  }

  const b = base.result as BehaviourReport;
  const h = head.result as BehaviourReport;
  const names = new Set<string>([
    ...Object.keys(b.entities),
    ...Object.keys(b.unpredicted ?? {}),
    ...Object.keys(h.entities),
    ...Object.keys(h.unpredicted ?? {}),
  ]);

  const rows: BehaviourDeltaRow[] = [];
  const sumsByCurrency = new Map<string, ComparableDeltaSum>();

  for (const name of [...names].sort(byCodeUnit)) {
    const baseFigure = has(b.entities, name) ? b.entities[name] : undefined;
    const headFigure = has(h.entities, name) ? h.entities[name] : undefined;
    const baseDeclined = has(b.unpredicted, name) ? b.unpredicted![name] : undefined;
    const headDeclined = has(h.unpredicted, name) ? h.unpredicted![name] : undefined;
    const type = baseDeclined?.type ?? headDeclined?.type;
    const row: BehaviourDeltaRow = {
      name,
      ...(type ? { type } : {}),
      kind: "comparable",
      ...(baseFigure ? { base: baseFigure } : {}),
      ...(headFigure ? { head: headFigure } : {}),
      ...(baseDeclined ? { baseDeclined } : {}),
      ...(headDeclined ? { headDeclined } : {}),
    };

    if (baseDeclined || headDeclined) {
      // Rule 2. A decline on either side is a row, and the row carries no
      // difference — whatever the other side priced, there is nothing to
      // difference it against.
      row.kind = "declined";
    } else if (baseFigure && headFigure) {
      // Rule 3. Every axis, not the first; the set is the contract's.
      const found = compareFigures(baseFigure, headFigure);
      if (found.size > 0) {
        row.kind = "marked";
        row.mismatches = FIGURE_MISMATCHES.filter((m) => found.has(m));
      } else {
        row.kind = "comparable";
        row.deltaPerHour = headFigure.cost.perHour - baseFigure.cost.perHour;
        row.currency = headFigure.cost.currency;
        const sum = sumsByCurrency.get(row.currency) ?? { currency: row.currency, perHour: 0, pairs: 0 };
        sum.perHour += row.deltaPerHour;
        sum.pairs += 1;
        sumsByCurrency.set(row.currency, sum);
      }
    } else if (baseFigure) {
      row.kind = "only-base";
    } else {
      row.kind = "only-head";
    }
    rows.push(row);
  }

  return {
    kind: "delta",
    base: { label: base.label, ...(base.ref ? { ref: base.ref } : {}), meta: b.meta },
    head: { label: head.label, ...(head.ref ? { ref: head.ref } : {}), meta: h.meta },
    rows,
    sums: [...sumsByCurrency.values()].sort((x, y) => byCodeUnit(x.currency, y.currency)),
    resilienceComparable:
      b.meta.edgeCoverage.verdict === "complete" && h.meta.edgeCoverage.verdict === "complete",
  };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

/** What the rendered finding is about — the words in its heading. */
export interface BehaviourFindingContext {
  /** The environment the prediction is for. */
  env: string;
  /** The Op that produced it, named in the heading so two Ops' findings read apart. */
  op: string;
}

/**
 * Four significant fractional digits at most, trailing zeros dropped. A rate
 * of `0.272` renders as `0.272`, of `3` as `3`, and of `0.00230000001` as
 * `0.0023`. No locale: the finding is the same bytes on every runner.
 */
export function formatPerHour(n: number): string {
  const fixed = n.toFixed(4);
  return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
}

/** A rate as a rate: `0.272 USD/hour`, never an amount. */
export function renderRate(rate: PredictedRate): string {
  return `${formatPerHour(rate.perHour)} ${rate.currency}/hour`;
}

/** A signed difference, `+0.4 USD/hour`, `-0.1 USD/hour`, `0 USD/hour`. */
function renderDelta(perHour: number, currency: string): string {
  const sign = perHour > 0 ? "+" : "";
  return `${sign}${formatPerHour(perHour)} ${currency}/hour`;
}

/** `acme-sim 1.4.2 · ±15% · modeled` — the four provenance fields, always together. */
export function renderProvenance(p: BehaviourProvenance): string {
  return `${p.engine} ${p.version} · ${p.tolerance} · ${p.basis}`;
}

function renderCoverage(c: BehaviourEdgeCoverage): string {
  const gaps: string[] = [];
  if (c.unresolvedKinds && c.unresolvedKinds.length > 0) gaps.push(`unresolved kinds: ${c.unresolvedKinds.join(", ")}`);
  if (c.dangling && c.dangling.length > 0) gaps.push(`${c.dangling.length} dangling reference(s)`);
  if (c.containmentEdges && c.containmentEdges.length > 0) gaps.push(`${c.containmentEdges.length} containment edge(s)`);
  return gaps.length > 0 ? `${c.verdict} (${gaps.join("; ")})` : c.verdict;
}

function renderAxis(name: string, before: number | undefined, after: number | undefined): string {
  const b = before === undefined ? "—" : formatPerHour(before);
  const a = after === undefined ? "—" : formatPerHour(after);
  return `${name} ${b} → ${a}`;
}

function renderHeadroom(base: PredictedBehaviour | undefined, head: PredictedBehaviour | undefined): string {
  const b = (base?.headroom ?? {}) as { cpu?: number; latency?: number };
  const h = (head?.headroom ?? {}) as { cpu?: number; latency?: number };
  return [renderAxis("cpu", b.cpu, h.cpu), renderAxis("latency", b.latency, h.latency)].join(" · ");
}

function renderVerdict(f: PredictedBehaviour | undefined): string {
  return f ? `${f.resilience.verdict} (${f.resilience.failure})` : "—";
}

function renderResilience(row: BehaviourDeltaRow, comparable: boolean): string {
  const { base, head } = row;
  if (!base || !head) return base ? `base ${renderVerdict(base)}` : head ? `head ${renderVerdict(head)}` : "—";
  if (comparable && base.resilience.failure === head.resilience.failure) {
    const arrow = base.resilience.verdict === head.resilience.verdict ? "=" : "→";
    return `${base.resilience.verdict} ${arrow} ${head.resilience.verdict} (${base.resilience.failure})`;
  }
  return `base ${renderVerdict(base)}; head ${renderVerdict(head)}`;
}

function renderRowProvenance(row: BehaviourDeltaRow): string {
  const { base, head } = row;
  if (base && head) {
    const b = renderProvenance(base.provenance);
    const h = renderProvenance(head.provenance);
    return b === h ? b : `base: ${b}; head: ${h}`;
  }
  return base ? renderProvenance(base.provenance) : head ? renderProvenance(head.provenance) : "—";
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function figureCell(f: PredictedBehaviour | undefined, declined: UnpredictedEntity | undefined): string {
  if (declined) return `declined: ${declined.reason}`;
  if (f) return renderRate(f.cost);
  return "—";
}

function deltaCell(row: BehaviourDeltaRow): string {
  switch (row.kind) {
    case "comparable":
      return renderDelta(row.deltaPerHour as number, row.currency as string);
    case "marked":
      return `marked: ${(row.mismatches ?? []).join(", ")}`;
    case "declined":
      return "no delta (declined)";
    case "only-base":
      return "removed";
    case "only-head":
      return "added";
  }
}

/**
 * The finding as Markdown, for a pull-request comment or a merge-request
 * note. Deterministic for a given delta.
 *
 * The first paragraph says what the numbers are, before any of them appear:
 * a modeled rate for one hypothetical hour, at the level the run was asked
 * for, from a named engine at a stated tolerance. The paragraph is not
 * decoration; it is rule 1 of the contract applied to prose.
 */
export function renderBehaviourFinding(delta: BehaviourDelta, ctx: BehaviourFindingContext): string {
  const lines: string[] = [];

  if (delta.kind === "no-prediction") {
    lines.push(`## Predicted behaviour for \`${ctx.env}\` — no prediction (Op \`${ctx.op}\`)`, "");
    lines.push(
      "No delta is shown and no figure is guessed locally. A prediction refused on one side is not a " +
        "prediction of zero on that side, so there is nothing to difference the other side against.",
      "",
    );
    for (const side of [delta.base, delta.head]) {
      if (!side.refusal) continue;
      const title = side.ref ? `${side.label} (${side.ref})` : side.label;
      lines.push(`**${title}**`, "", "```", renderBehaviourRefusal(side.refusal, { color: false }), "```", "");
    }
    return lines.join("\n").trimEnd() + "\n";
  }

  const traffic = delta.head.meta.at.traffic;
  lines.push(`## Predicted behaviour for \`${ctx.env}\` at \`${traffic}\` (Op \`${ctx.op}\`)`, "");
  lines.push(
    "A prediction, not a measurement. Every figure below is one engine's modeled rate for one hypothetical " +
      "hour at the stated traffic level, shown with that engine's name, version, stated tolerance and basis " +
      "(`modeled` from list prices, or `validated`). Nothing here is an amount owed for an hour that happened.",
    "",
  );

  lines.push("| Side | Predicted from | Engine | Traffic level | Edge coverage | Engine's own estate total |");
  lines.push("|---|---|---|---|---|---|");
  for (const side of [delta.base, delta.head]) {
    const total = side.meta.total ? renderRate(side.meta.total) : "not stated";
    lines.push(
      `| ${side.label} | ${cell(side.ref ?? "—")} | ${cell(`${side.meta.engine} ${side.meta.version}`)} | ` +
        `${cell(side.meta.at.traffic)} | ${cell(renderCoverage(side.meta.edgeCoverage))} | ${total} |`,
    );
  }
  lines.push("");
  if (delta.base.meta.at.traffic !== delta.head.meta.at.traffic) {
    lines.push(
      `The two sides were predicted at different traffic levels (\`${delta.base.meta.at.traffic}\` and ` +
        `\`${delta.head.meta.at.traffic}\`), so every pair below is marked \`mixed-level\` and none is differenced.`,
      "",
    );
  }
  if (!delta.resilienceComparable) {
    lines.push(
      "Resilience verdicts are shown per side and **not compared**: edge coverage is " +
        `\`${delta.base.meta.edgeCoverage.verdict}\` on ${delta.base.label} and ` +
        `\`${delta.head.meta.edgeCoverage.verdict}\` on ${delta.head.label}, so the two verdicts were computed ` +
        "over graphs of different completeness, and a difference between them is not a difference in the estate.",
      "",
    );
  }

  lines.push(
    "| Entity | Type | " +
      `${delta.base.label} | ${delta.head.label} | Delta per hour | Headroom (${delta.base.label} → ${delta.head.label}) | ` +
      "Resilience | Provenance |",
  );
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const row of delta.rows) {
    lines.push(
      `| ${cell(row.name)} | ${cell(row.type ?? "")} | ${cell(figureCell(row.base, row.baseDeclined))} | ` +
        `${cell(figureCell(row.head, row.headDeclined))} | ${cell(deltaCell(row))} | ` +
        `${cell(renderHeadroom(row.base, row.head))} | ${cell(renderResilience(row, delta.resilienceComparable))} | ` +
        `${cell(renderRowProvenance(row))} |`,
    );
  }
  lines.push("");

  const marked = delta.rows.filter((r) => r.kind === "marked").length;
  const declined = delta.rows.filter((r) => r.kind === "declined").length;
  const oneSided = delta.rows.filter((r) => r.kind === "only-base" || r.kind === "only-head").length;
  if (delta.sums.length > 0) {
    for (const sum of delta.sums) {
      lines.push(
        `Sum of the comparable deltas: **${renderDelta(sum.perHour, sum.currency)}** over ${sum.pairs} pair(s). ` +
          "This is chant's own arithmetic over the comparable rows above and not an engine figure; it excludes " +
          `${marked} marked pair(s), ${declined} declined entit${declined === 1 ? "y" : "ies"} and ${oneSided} ` +
          "entit" + (oneSided === 1 ? "y" : "ies") + " present on one side only.",
      );
    }
    lines.push("");
  } else {
    lines.push("No pair is comparable, so no delta is summed.", "");
  }

  const declinedRows = delta.rows.filter((r) => r.kind === "declined");
  if (declinedRows.length > 0) {
    lines.push("### Declined entities", "");
    lines.push(
      "An entity the engine could not price is reported, not priced at nothing. It carries no delta on either " +
        "side; the reason is the lexicon's own.",
      "",
    );
    for (const row of declinedRows) {
      for (const [label, d] of [
        [delta.base.label, row.baseDeclined],
        [delta.head.label, row.headDeclined],
      ] as const) {
        if (!d) continue;
        lines.push(`- \`${row.name}\` on ${label}: \`${d.reason}\`${d.detail ? ` — ${d.detail}` : ""}`);
      }
    }
    lines.push("");
  }

  const hints = delta.rows.filter((r) => r.head?.rightSize);
  if (hints.length > 0) {
    lines.push(`### Right-size hints on ${delta.head.label}`, "");
    for (const row of hints) {
      const rs = row.head!.rightSize!;
      lines.push(`- \`${row.name}\`: ${rs.suggestion}${rs.reason ? ` — ${rs.reason}` : ""}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
