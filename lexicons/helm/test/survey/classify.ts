/**
 * Pinnability classification for the survey harness (#1231, epic #1228).
 *
 * A render is pinnable exactly when every input to it is closed. `helm
 * template` has three inputs beyond (chart, values) that are silently
 * defaulted or silently empty:
 *
 *   - cluster capabilities  — closable via --kube-version / --api-versions
 *   - generated values      — closable by supplying the value as an input
 *   - cluster state (lookup) — not closable offline
 *
 * The functions here detect each. Two classifier bugs from the epic's
 * prototype are deliberately fixed (the survey corpus regresses them):
 *
 *   - finding 9: `lookup` must be found in template ACTIONS, not text.
 *     cert-manager has 52 textual "lookup" hits, all comment prose, real
 *     template-action count 0.
 *   - finding 10: CRD routing must match a `crds/` path SEGMENT, not prefix.
 *     A subchart CRD arrives as `<parent>/charts/<child>/crds/<file>`; a
 *     prefix rule catches 0 of them.
 *
 * This module is self-contained on purpose — no imports from the lexicon's
 * src/ — so the harness runs without generated artifacts. #1234 ports the
 * classifier into the lexicon proper; these findings are its design input.
 */

export interface TemplateAction {
  /** Path of the file the action was found in (as given by the caller). */
  file: string;
  /** 1-based line the action starts on. */
  line: number;
  /** The action body between `{{` and `}}`, trim markers stripped. */
  body: string;
}

/**
 * Extract Go template actions (`{{ ... }}`) from a template source, skipping
 * comment actions (`{{/* ... *\/}}`). Text outside actions — including YAML
 * `#` comments, where finding 9's 52 false positives lived — is never
 * inspected by any scan built on this.
 */
export function extractActions(source: string, file: string): TemplateAction[] {
  const actions: TemplateAction[] = [];
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{{", i);
    if (open === -1) break;
    const line = source.slice(0, open).split("\n").length;
    // Body starts after `{{` and an optional trim marker.
    let bodyStart = open + 2;
    if (source[bodyStart] === "-") bodyStart += 1;
    const rest = source.slice(bodyStart);
    // Comment action: {{/* ... */}} — skip to its closing */}}.
    if (/^\s*\/\*/.test(rest)) {
      const closeComment = source.indexOf("*/", bodyStart);
      if (closeComment === -1) break;
      const close = source.indexOf("}}", closeComment);
      i = close === -1 ? source.length : close + 2;
      continue;
    }
    const close = source.indexOf("}}", bodyStart);
    if (close === -1) break;
    let body = source.slice(bodyStart, close);
    if (body.endsWith("-")) body = body.slice(0, -1);
    actions.push({ file, line, body: body.trim() });
    i = close + 2;
  }
  return actions;
}

export interface LookupHit {
  file: string;
  line: number;
  action: string;
}

export interface LookupScan {
  /**
   * `lookup` inside an `if` / `else if` / `with` / `range` action. Changes
   * which documents exist; no value substitution recovers that. Hard refusal.
   */
  controlFlow: LookupHit[];
  /**
   * `lookup` in value position. Closable by declaring the value as an input.
   */
  valuePosition: LookupHit[];
}

/**
 * Matches a call to the `lookup` template function: the word `lookup`
 * followed by whitespace (it always takes arguments), not preceded by a word
 * character, `.` or `$` — so `.Values.persistence.lookupVolumeName` (a value
 * named after the feature, present in grafana) is not a hit.
 */
const LOOKUP_CALL = /(?<![.\w$])lookup\s/;

/** An action whose pipeline is control flow: if / else if / with / range. */
const CONTROL_FLOW = /^(if\b|else\s+if\b|with\b|range\b)/;

export function scanLookups(actions: TemplateAction[]): LookupScan {
  const scan: LookupScan = { controlFlow: [], valuePosition: [] };
  for (const a of actions) {
    if (!LOOKUP_CALL.test(a.body)) continue;
    const hit = { file: a.file, line: a.line, action: a.body };
    if (CONTROL_FLOW.test(a.body)) scan.controlFlow.push(hit);
    else scan.valuePosition.push(hit);
  }
  return scan;
}

/**
 * Count `.Capabilities.KubeVersion` / `.Capabilities.APIVersions` references
 * in template actions. Any hit makes the capability profile a required
 * declared input: the default is a property of the helm BINARY (3.16.2 says
 * v1.31.0, 4.1.1 says v1.35.0), so an unpinned render's digest depends on
 * who rendered it.
 */
export function countCapabilityRefs(actions: TemplateAction[]): number {
  let n = 0;
  for (const a of actions) {
    const m = a.body.match(/\.Capabilities\.(KubeVersion|APIVersions)/g);
    if (m) n += m.length;
  }
  return n;
}

/** Split a `helm template` stream into non-empty documents. */
export function splitDocuments(rendered: string): string[] {
  return rendered
    .split(/^---$/m)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
}

/** The `# Source: <chart>/<path>` origin of a rendered document, if any. */
export function sourcePath(doc: string): string | undefined {
  const m = doc.match(/^# Source: \S+?\/(\S+)$/m);
  return m ? m[1] : undefined;
}

/**
 * Finding 10: segment matching, not prefix matching. A subchart's CRDs
 * arrive as `charts/<child>/crds/<file>`; `startsWith("crds/")` catches
 * 0 of them and would route every one into templates/, making it deletable
 * on uninstall.
 */
export function isCrdSource(path: string): boolean {
  return /(^|\/)crds\//.test(path);
}

export interface RoutedDocuments {
  crds: string[];
  templates: string[];
}

/** Route rendered documents by origin: `crds/`-segment sources vs the rest. */
export function routeBySource(rendered: string): RoutedDocuments {
  const routed: RoutedDocuments = { crds: [], templates: [] };
  for (const doc of splitDocuments(rendered)) {
    const p = sourcePath(doc);
    (p !== undefined && isCrdSource(p) ? routed.crds : routed.templates).push(doc);
  }
  return routed;
}

export type Verdict = "deterministic-as-is" | "pinnable-with-closed-inputs" | "unpinnable";

export interface Classification {
  verdict: Verdict;
  /** Why, one entry per open input (or per refusal cause). */
  reasons: string[];
}

export interface ClassificationInput {
  lookups: LookupScan;
  capabilityRefs: number;
  /** Did two renders with closed inputs produce identical bytes? */
  stable: boolean;
  /** Lines differing between the two renders (0 when stable). */
  unstableLines: number;
  /** Was a values file required/supplied to render at all? */
  valuesSupplied: boolean;
}

/**
 * The gate. Not "is this chart deterministic" but "are all of this render's
 * inputs closed" — a property of (chart, values), not of the chart alone.
 */
export function classify(input: ClassificationInput): Classification {
  const reasons: string[] = [];

  if (input.lookups.controlFlow.length > 0) {
    for (const h of input.lookups.controlFlow) {
      reasons.push(`lookup in control flow at ${h.file}:${h.line}`);
    }
    return { verdict: "unpinnable", reasons };
  }

  if (input.capabilityRefs > 0) {
    reasons.push(`declare capability profile (${input.capabilityRefs} .Capabilities refs)`);
  }
  for (const h of input.lookups.valuePosition) {
    reasons.push(`declare input for value-position lookup at ${h.file}:${h.line}`);
  }
  if (!input.stable) {
    reasons.push(
      `open generated input: double render differs on ${input.unstableLines} lines — supply the value(s) as declared inputs`,
    );
  }
  if (input.valuesSupplied) {
    reasons.push("values file supplied as closed input");
  }

  if (reasons.length === 0) return { verdict: "deterministic-as-is", reasons };
  return { verdict: "pinnable-with-closed-inputs", reasons };
}

/** Count lines that differ between two renders (symmetric, order-blind). */
export function countDifferingLines(a: string, b: string): number {
  if (a === b) return 0;
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const count = new Map<string, number>();
  for (const l of linesA) count.set(l, (count.get(l) ?? 0) + 1);
  for (const l of linesB) count.set(l, (count.get(l) ?? 0) - 1);
  let diff = 0;
  for (const n of count.values()) diff += Math.abs(n);
  return diff;
}
