/**
 * The pinnability gate (#1234, epic #1228 Phase 1).
 *
 * A render is pinnable exactly when every input to it is closed. `helm
 * template` has three inputs beyond (chart, values) that are silently
 * defaulted or silently empty:
 *
 *   - cluster capabilities   — closable via --kube-version / --api-versions
 *   - generated values       — closable by supplying the value as an input
 *   - cluster state (lookup) — not closable offline
 *
 * The gate is therefore not "is this chart deterministic" but "are all of
 * this render's inputs closed" — a property of `(chart, values)`, not of the
 * chart alone. Concretely:
 *
 *   - A control-flow `lookup` that is REACHABLE under the supplied values is
 *     a hard refusal: it changes which documents exist, and no value
 *     substitution recovers that.
 *   - A control-flow `lookup` the supplied values leave gated OFF is a
 *     recorded conditional hazard, not a refusal — bundled grafana's
 *     `lookup` behind `persistence.enabled: false` never runs, so the
 *     render is pinnable; flipping that value re-classifies the pair.
 *   - Value-position `lookup` is a declared-input requirement (epic
 *     Decisions): it changes a field, not the document set.
 *   - `.Capabilities.*` references require an explicit capability profile —
 *     the default is a property of the helm BINARY (3.16.2 says v1.31.0,
 *     4.1.1 says v1.35.0), so an unpinned render's digest depends on who
 *     rendered it. 11 of the 13 survey charts hit this; it is the normal
 *     case, not an error.
 *   - Generated values (`randAlphaNum` and friends) are detected statically
 *     and named; the double-render localizer (#1236) confirms them
 *     dynamically. They classify as closable when a `.Values` path in the
 *     same action can supply them.
 *
 * A chart that fails is refused with the specific construct and location,
 * and keeps working unpinned. Adoption is incremental.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  actionPipeline,
  extractActions,
  scopeActions,
  type ScopeFrame,
  type ScopedAction,
} from "./actions";
import {
  UNKNOWN,
  callReachability,
  evaluateCondition,
  truthy,
  type EvalContext,
  type GatePath,
  type Tri,
} from "./conditions";
import {
  buildChartInstances,
  mergeValues,
  readYamlFile,
  valueAtPath,
  type ChartInstance,
} from "./values";

export type PinnabilityVerdict = "deterministic" | "pinnable" | "unpinnable";

/** One `.Capabilities.*` reference; any of these makes a profile required. */
export interface CapabilityRequirement {
  file: string;
  line: number;
  capability: "KubeVersion" | "APIVersions";
}

/** An input that must be (or has been) closed for the render to pin. */
export interface ClosedInput {
  kind: "generated-value" | "value-position-lookup" | "supplied-values";
  file?: string;
  line?: number;
  /** Template function for generated values (randAlphaNum, genCA, ...). */
  fn?: string;
  /** Root-scoped `.Values` path that can supply the input, when one exists. */
  valuesPath?: string;
  /** Can this input be closed by supplying a value at all? */
  suppliable?: boolean;
  detail: string;
}

/**
 * A control-flow `lookup` the supplied values leave unreachable. Recorded —
 * not refused — so that flipping the gating value later re-classifies the
 * `(chart, values)` pair instead of silently changing which documents exist.
 */
export interface ConditionalHazard {
  /** Instance scope in root coordinates ("" = the top-level chart, "grafana" = that subchart). */
  chart: string;
  file: string;
  line: number;
  /** The values path(s) currently gating the construct off, with their values. */
  gates: GatePath[];
  detail: string;
}

/** A control-flow `lookup` site, aggregated across chart instances. */
export interface ControlFlowLookup {
  file: string;
  line: number;
  action: string;
  status: "refused" | "hazard";
  /** Instance scopes the site was assessed in ("" = root). */
  charts: string[];
}

export interface ValuePositionLookup {
  file: string;
  line: number;
  action: string;
}

/** Evidence from an actual double render (#1236 owns producing this). */
export interface RenderEvidence {
  stable: boolean;
  unstableLines: number;
}

export interface PinnabilityReport {
  verdict: PinnabilityVerdict;
  /** `.Capabilities.*` references, one entry per occurrence. Empty = no profile needed. */
  requiresProfile: CapabilityRequirement[];
  closedInputs: ClosedInput[];
  hazards: ConditionalHazard[];
  /** Human-readable summary; refusal reasons first, specific per construct. */
  reasons: string[];
  /** Raw lookup findings, for surfaces that need counts or locations. */
  lookups: {
    controlFlow: ControlFlowLookup[];
    valuePosition: ValuePositionLookup[];
  };
  /** Non-fatal scan caveats (an unvendored dependency, etc.). */
  warnings: string[];
}

export interface ClassifyChartOptions {
  /** Values overrides, as `helm template --values` would merge them. */
  values?: unknown;
  /** Values files to load and merge (in order) over the chart defaults. */
  valuesFiles?: string[];
  /** Double-render evidence, when the caller has rendered. */
  renderEvidence?: RenderEvidence;
}

/**
 * Matches a call to the `lookup` template function: the word `lookup`
 * followed by whitespace (it always takes arguments), not preceded by a word
 * character, `.` or `$` — so `.Values.persistence.lookupVolumeName` (a value
 * named after the feature, present in grafana) is not a hit. Finding 9's
 * word-boundary lesson: `\blookup\b` false-positives on the very chart the
 * refusal is about.
 */
const LOOKUP_CALL = /(?<![.\w$])lookup\s/;
const LOOKUP_FN = /^lookup$/;

/**
 * Template functions whose output differs per render: sprig's random and
 * crypto generators, plus `now`. Detected statically so the classifier can
 * NAME the open input; the double-render localizer (#1236) is what proves
 * one fired.
 */
const GENERATED_VALUE_FNS = [
  "randAlphaNum",
  "randAlpha",
  "randNumeric",
  "randAscii",
  "randBytes",
  "randInt",
  "uuidv4",
  "derivePassword",
  "genPrivateKey",
  "genCA",
  "genCAWithKey",
  "genSelfSignedCert",
  "genSelfSignedCertWithKey",
  "genSignedCert",
  "genSignedCertWithKey",
  "htpasswd",
  "bcrypt",
  "now",
] as const;

const GENERATED_CALL = new RegExp(
  `(?<![.\\w$])(${GENERATED_VALUE_FNS.join("|")})\\b`,
);

const CAPABILITY_REF = /\.Capabilities\.(KubeVersion|APIVersions)/g;

/** Structural kinds whose pipeline decides which documents exist. */
const CONTROL_FLOW_KINDS = new Set(["if", "elseif", "with", "range"]);

const VALUES_PATH_IN_ACTION = /\$?\.Values((?:\.[A-Za-z0-9_-]+)+)/;

// --- per-directory scanning ------------------------------------------------

interface ScannedFile {
  /** Path relative to the chart directory that owns it. */
  rel: string;
  scoped: ScopedAction[];
}

/**
 * Template files of ONE chart directory — `templates/` at any depth below
 * it, excluding `charts/` (subcharts are their own instances) and NOTES.txt
 * (rendered for the console, not the cluster).
 */
export function collectOwnTemplateFiles(chartDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, underTemplates: boolean): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) {
        if (entry === "charts" && !underTemplates) continue;
        walk(p, underTemplates || entry === "templates");
        continue;
      }
      if (!underTemplates) continue;
      if (entry === "NOTES.txt") continue;
      if (/\.(ya?ml|tpl)$/.test(entry)) out.push(p);
    }
  };
  walk(chartDir, false);
  return out;
}

function scanDir(chartDir: string): ScannedFile[] {
  return collectOwnTemplateFiles(chartDir)
    .sort()
    .map((file) => {
      const rel = file.slice(chartDir.length + 1);
      return { rel, scoped: scopeActions(extractActions(readFileSync(file, "utf8"), rel)) };
    });
}

// --- gating ----------------------------------------------------------------

/**
 * Walk the enclosing frames of an action and decide whether the supplied
 * values leave it unreachable. Returns the gates that close it, or null when
 * every frame is (or may be) open — in which case the construct counts as
 * reachable.
 */
function framesGate(
  frames: ScopeFrame[],
  instance: ChartInstance,
): { gates: GatePath[] | null; allKnown: boolean } {
  // Dot binding threads through the frames: `with .Values.persistence`
  // rebinds bare `.enabled` to `persistence.enabled` for everything inside.
  let dot: string[] | null | undefined = null;
  let allKnown = true;
  for (const frame of frames) {
    const ctx: EvalContext = {
      values: instance.values,
      scope: instance.scope,
      dotValuesPath: dot,
    };
    for (const cond of frame.conditions) {
      const r = evaluateCondition(cond, ctx);
      if (r.value === false) return { gates: r.gates, allKnown };
      if (r.value === UNKNOWN) allKnown = false;
    }
    for (const negated of frame.negatedConditions) {
      // An else/else-if branch runs only when every earlier condition was
      // false; a definitively TRUE earlier condition closes the branch.
      const r = evaluateCondition(negated, ctx);
      if (r.value === true) {
        const m = negated.match(VALUES_PATH_IN_ACTION);
        return {
          gates: m
            ? [{ path: [...instance.scope, ...m[1].slice(1).split(".")].join("."), value: true }]
            : [],
          allKnown,
        };
      }
      if (r.value === UNKNOWN) allKnown = false;
    }
    if (frame.kind === "with") dot = frame.dotUnresolvable ? undefined : (frame.dotValuesPath ?? undefined);
    else if (frame.kind === "range") dot = undefined;
    else if (frame.kind === "define" || frame.kind === "block") dot = null;
  }
  return { gates: null, allKnown };
}

/** Reachability of a function call inside an action, frames + same-action gates. */
function assessCall(
  scopedAction: ScopedAction,
  fnRe: RegExp,
  instance: ChartInstance,
): { reachable: Tri; gates: GatePath[] } {
  if (instance.disabledBy !== undefined) {
    return {
      reachable: false,
      gates: [{ path: instance.disabledBy, value: false }],
    };
  }
  const enclosing = framesGate(scopedAction.frames, instance);
  if (enclosing.gates !== null) return { reachable: false, gates: enclosing.gates };
  // Same-action short-circuit gating: `if and .Values.gate (lookup ...)`
  // never calls lookup when the gate is false.
  let dot: string[] | null | undefined = null;
  for (const frame of scopedAction.frames) {
    if (frame.kind === "with") dot = frame.dotUnresolvable ? undefined : (frame.dotValuesPath ?? undefined);
    else if (frame.kind === "range") dot = undefined;
    else if (frame.kind === "define" || frame.kind === "block") dot = null;
  }
  const ctx: EvalContext = { values: instance.values, scope: instance.scope, dotValuesPath: dot };
  const inAction = callReachability(actionPipeline(scopedAction.action), fnRe, ctx);
  // An enclosing gate we could not resolve leaves reachability unproven even
  // when nothing in the action itself gates the call.
  if (inAction.reachable === true && !enclosing.allKnown) {
    return { reachable: UNKNOWN, gates: [] };
  }
  return inAction;
}

// --- classification --------------------------------------------------------

/**
 * Classify a chart directory against the values a render would be given.
 * Subchart-recursive: dependencies vendored under `charts/` are scanned with
 * their own effective values (aliases get their own scope, `condition:`-
 * disabled dependencies gate their contents — findings 11 and 12).
 */
export function classifyChart(
  chartDir: string,
  options: ClassifyChartOptions = {},
): PinnabilityReport {
  let supplied: unknown;
  for (const file of options.valuesFiles ?? []) {
    supplied = mergeValues(supplied ?? {}, readYamlFile(file));
  }
  if (options.values !== undefined) supplied = mergeValues(supplied ?? {}, options.values);
  const valuesSupplied = supplied !== undefined;

  const { instances, warnings } = buildChartInstances(chartDir, supplied);

  const requiresProfile: CapabilityRequirement[] = [];
  const valuePosition: ValuePositionLookup[] = [];
  interface ControlFlowSite {
    file: string;
    line: number;
    action: string;
    assessments: { chart: string; reachable: Tri; gates: GatePath[] }[];
  }
  const controlFlowSites = new Map<string, ControlFlowSite>();
  interface GeneratedSite {
    file: string;
    line: number;
    fn: string;
    /** Open in at least one instance; gates recorded when closed everywhere. */
    open: boolean;
    valuesPath?: string;
    suppliable: boolean;
  }
  const generatedSites = new Map<string, GeneratedSite>();

  const dirScans = new Map<string, ScannedFile[]>();
  const staticallyRecordedDirs = new Set<string>();

  for (const instance of instances) {
    let files = dirScans.get(instance.dir);
    if (files === undefined) {
      files = scanDir(instance.dir);
      dirScans.set(instance.dir, files);
    }
    // Static findings (capability refs, value-position lookups) are
    // per-FILE: an aliased dependency scans the same directory for two
    // instances but its files exist once.
    const recordStatic = !staticallyRecordedDirs.has(instance.dir);
    staticallyRecordedDirs.add(instance.dir);

    for (const { rel, scoped } of files) {
      const file = instance.relDir === "" ? rel : `${instance.relDir}/${rel}`;
      for (const s of scoped) {
        const { action } = s;

        if (recordStatic) {
          for (const m of action.body.matchAll(CAPABILITY_REF)) {
            requiresProfile.push({
              file,
              line: action.line,
              capability: m[1] as CapabilityRequirement["capability"],
            });
          }
        }

        if (LOOKUP_CALL.test(action.body)) {
          if (CONTROL_FLOW_KINDS.has(action.kind)) {
            const key = `${file}:${action.line}`;
            let site = controlFlowSites.get(key);
            if (site === undefined) {
              site = { file, line: action.line, action: action.body, assessments: [] };
              controlFlowSites.set(key, site);
            }
            const a = assessCall(s, LOOKUP_FN, instance);
            site.assessments.push({
              chart: instance.scope.join("."),
              reachable: a.reachable,
              gates: a.gates,
            });
          } else if (recordStatic) {
            valuePosition.push({ file, line: action.line, action: action.body });
          }
        }

        const gen = action.body.match(GENERATED_CALL);
        if (gen !== null) {
          const a = assessCall(s, new RegExp(`^${gen[1]}$`), instance);
          // A generator whose enclosing gates are definitively closed cannot
          // fire for this render; re-classification on a values flip
          // rediscovers it.
          if (a.reachable !== false) {
            const valuesRef = action.body.match(VALUES_PATH_IN_ACTION);
            const relPath = valuesRef ? valuesRef[1].slice(1).split(".") : undefined;
            // Open unless the suppliable value is already set (a truthy
            // value makes `x | default (randAlphaNum ...)` deterministic).
            const open =
              relPath === undefined || !truthy(valueAtPath(instance.values, relPath));
            const key = `${file}:${action.line}:${gen[1]}`;
            const existing = generatedSites.get(key);
            if (existing === undefined) {
              generatedSites.set(key, {
                file,
                line: action.line,
                fn: gen[1],
                open,
                valuesPath: relPath ? [...instance.scope, ...relPath].join(".") : undefined,
                suppliable: relPath !== undefined,
              });
            } else if (open) {
              existing.open = true;
            }
          }
        }
      }
    }
  }

  // --- fold findings into the report ---------------------------------------

  const reasons: string[] = [];
  const hazards: ConditionalHazard[] = [];
  const controlFlow: ControlFlowLookup[] = [];
  let refusals = 0;

  for (const site of controlFlowSites.values()) {
    const reachableIn = site.assessments.filter((a) => a.reachable !== false);
    if (reachableIn.length > 0) {
      refusals += 1;
      controlFlow.push({
        file: site.file,
        line: site.line,
        action: site.action,
        status: "refused",
        charts: site.assessments.map((a) => a.chart),
      });
      for (const a of reachableIn) {
        const where = a.chart === "" ? "" : ` (subchart ${a.chart})`;
        const proof =
          a.reachable === UNKNOWN
            ? "not provably gated off by the supplied values"
            : "reachable with the supplied values";
        reasons.push(
          `lookup in control flow at ${site.file}:${site.line}${where} — ${proof}; which documents exist depends on cluster state`,
        );
      }
    } else {
      controlFlow.push({
        file: site.file,
        line: site.line,
        action: site.action,
        status: "hazard",
        charts: site.assessments.map((a) => a.chart),
      });
      for (const a of site.assessments) {
        const gateText = a.gates.map((g) => `${g.path}=${JSON.stringify(g.value ?? null)}`).join(", ");
        hazards.push({
          chart: a.chart,
          file: site.file,
          line: site.line,
          gates: a.gates,
          detail: `control-flow lookup at ${site.file}:${site.line} is gated off by ${gateText} — flipping it makes this render unpinnable`,
        });
      }
    }
  }

  // The report stays fully populated even for a refused chart: the caller
  // renders unpinned and still benefits from knowing the other open inputs.
  const closedInputs: ClosedInput[] = [];

  if (requiresProfile.length > 0) {
    reasons.push(`declare capability profile (${requiresProfile.length} .Capabilities refs)`);
  }

  for (const v of valuePosition) {
    closedInputs.push({
      kind: "value-position-lookup",
      file: v.file,
      line: v.line,
      suppliable: true,
      detail: `declare input for value-position lookup at ${v.file}:${v.line}`,
    });
    reasons.push(`declare input for value-position lookup at ${v.file}:${v.line}`);
  }

  for (const g of generatedSites.values()) {
    if (!g.open) continue;
    const supply = g.suppliable
      ? `suppliable via ${g.valuesPath}`
      : "no suppliable value found in the action — the double-render localizer (#1236) must confirm and localize it";
    closedInputs.push({
      kind: "generated-value",
      file: g.file,
      line: g.line,
      fn: g.fn,
      valuesPath: g.valuesPath,
      suppliable: g.suppliable,
      detail: `open generated input ${g.fn} at ${g.file}:${g.line} — ${supply}`,
    });
    reasons.push(`open generated input ${g.fn} at ${g.file}:${g.line} — ${supply}`);
  }

  if (options.renderEvidence !== undefined && !options.renderEvidence.stable) {
    reasons.push(
      `open generated input: double render differs on ${options.renderEvidence.unstableLines} lines — supply the value(s) as declared inputs`,
    );
  }

  for (const h of hazards) {
    reasons.push(`conditional hazard: ${h.detail}`);
  }

  if (valuesSupplied) {
    closedInputs.push({ kind: "supplied-values", detail: "values supplied as closed input" });
    reasons.push("values supplied as closed input");
  }

  for (const w of warnings) reasons.push(`warning: ${w}`);

  let verdict: PinnabilityVerdict;
  if (refusals > 0) {
    verdict = "unpinnable";
  } else if (
    requiresProfile.length > 0 ||
    closedInputs.length > 0 ||
    hazards.length > 0 ||
    (options.renderEvidence !== undefined && !options.renderEvidence.stable)
  ) {
    verdict = "pinnable";
  } else {
    verdict = "deterministic";
  }

  return {
    verdict,
    requiresProfile,
    closedInputs,
    hazards,
    reasons,
    lookups: { controlFlow, valuePosition },
    warnings,
  };
}
