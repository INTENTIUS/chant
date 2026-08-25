/**
 * Double-render localizer for open generated inputs (#1236, epic #1228
 * Phase 1).
 *
 * The static classifier (#1234) NAMES generator sites; this module proves
 * which of them actually fire and maps every unstable output line back to
 * the input that produced it. The mechanism is the epic's own: pin the
 * input, not the output. For each candidate values path that could close a
 * generator, render the chart twice with that path pinned — the lines that
 * stop differing are the lines that input produced, cascades included
 * (finding 6: one `randAlphaNum` admin password differed as the secret line
 * PLUS a `checksum/secret` annotation derived from it; hoisting the secret
 * alone would have desynchronized the checksum and silently broken
 * restart-on-change).
 *
 * Candidate pins come from three static sources, each validated dynamically
 * before being suggested:
 *
 *   1. the generator's own action (`x | default (randAlphaNum 16)` — the
 *      classifier already names `x`),
 *   2. enclosing control-flow gates (`if not .Values.core.existingSecret`
 *      around the generator: supplying the existing-secret slot closes it),
 *   3. the include chain — a generator inside `define "grafana.password"`
 *      inherits the gates of every `include "grafana.password"` site, which
 *      is where grafana's `{{- if .Values.adminPassword }} ... {{- else }}`
 *      supply slot lives.
 *
 * A differing line no probe and no source mapping can explain is reported as
 * UNLOCALIZED instability — never silently pinnable. A base double render
 * with zero differing lines confirms the chart deterministic.
 */

import { readFileSync } from "node:fs";

import {
  extractActions,
  scopeActions,
  type ScopedAction,
} from "./actions";
import {
  collectOwnTemplateFiles,
  type ClosedInput,
  type PinnabilityReport,
} from "./classify";
import { parseExpr, type ExprNode } from "./conditions";
import { splitDocuments, sourcePath } from "./render-stream";
import {
  buildChartInstances,
  mergeValues,
  readYamlFile,
  valueAtPath,
  type ChartInstance,
} from "./values";

/** Renders the chart with the given values paths pinned to literal strings. */
export type RenderFn = (pins: Record<string, string>) => string;

export type PinStyle = "supply" | "existing-slot" | "gate";

export interface CandidatePin {
  /** Root-scoped values path. */
  path: string;
  style: PinStyle;
}

/** One unstable output line, located in the rendered document set. */
export interface LocalizedOccurrence {
  /** Source template of the rendered document (`# Source:` origin). */
  doc: string;
  /** `Kind/name` of the document, when parseable. */
  docId: string;
  /** YAML key of the differing line (`admin-password`, `checksum/secret`). */
  key: string;
  /** 1-based line within the document, from the first base render. */
  line: number;
  /**
   * The line lives in a different template than the generator — a derived
   * field (checksum annotation, re-included secret) grouped under its root
   * input rather than reported as independent instability.
   */
  derived: boolean;
}

/** One open generated input with the unstable lines localized to it. */
export interface LocalizedInput {
  fn: string;
  /** Template file and line of the generator (classifier coordinates). */
  file: string;
  line: number;
  /** The values path a supply-style pin uses, when one validated. */
  valuesPath?: string;
  /** A validated pin exists — supplying a value closes this input. */
  suppliable: boolean;
  /**
   * The concrete values entry a user adds to close the input, e.g.
   * `adminPassword: <generate once and supply>`. Absent when no candidate
   * pin validated (the input is real but not closable via values).
   */
  suggestedPin?: string;
  /** Chart-provided slots that also close it (`admin.existingSecret`). */
  existingSlots: string[];
  occurrences: LocalizedOccurrence[];
}

export interface LocalizationReport {
  /** The base double render differed on zero lines. */
  deterministic: boolean;
  /** Differing line count of the base double render (per-render lines). */
  differingLines: number;
  inputs: LocalizedInput[];
  /** Differing lines no probe and no source mapping explains. */
  unlocalized: LocalizedOccurrence[];
  /**
   * Pinning every validated pin at once yields a stable render. Present
   * only when at least one pin validated.
   */
  stableWithAllPins?: boolean;
  /** How many `helm template` invocations the localization used. */
  renders: number;
}

export interface LocalizeOptions {
  render: RenderFn;
  /** Values overrides, as `helm template --values` would merge them. */
  values?: unknown;
  /** Values files merged (in order) over the chart defaults. */
  valuesFiles?: string[];
  /** Probe budget per generator site (default 6). */
  maxProbesPerInput?: number;
}

const PROBE_VALUE = "chant-localizer-probe";

// --- diffing with stable line identity -------------------------------------

interface DiffOccurrence {
  ident: string;
  doc: string;
  docId: string;
  key: string;
  line: number;
}

function docIdOf(doc: string): string {
  const kind = doc.match(/^kind: (\S+)/m)?.[1];
  const name = doc.match(/^ {2}name: "?([^"\n]+)"?$/m)?.[1];
  if (kind === undefined) return "?";
  return name === undefined ? kind : `${kind}/${name}`;
}

function lineKeyOf(text: string, index: number): string {
  const m = text.match(/^\s*(?:- )?"?([^:"]{1,120}?)"?:/);
  return m ? m[1] : `@${index}`;
}

/** Differing line indices of one paired document, positional. */
function diffDocLines(la: string[], lb: string[]): number[] {
  if (la.length === lb.length) {
    const out: number[] = [];
    for (let i = 0; i < la.length; i++) if (la[i] !== lb[i]) out.push(i);
    return out;
  }
  // Unequal shapes: peel the common prefix and suffix, count A's middle.
  let start = 0;
  while (start < la.length && start < lb.length && la[start] === lb[start]) start++;
  let endA = la.length;
  let endB = lb.length;
  while (endA > start && endB > start && la[endA - 1] === lb[endB - 1]) {
    endA--;
    endB--;
  }
  const out: number[] = [];
  for (let i = start; i < endA; i++) out.push(i);
  return out;
}

/**
 * Diff two renders of the SAME inputs into a set of differing-line
 * occurrences with identities stable across separate probe runs: documents
 * pair by (`# Source:` origin, ordinal), lines identify by their YAML key
 * plus ordinal rather than raw content — the content is exactly what varies.
 */
export function diffRenderPair(a: string, b: string): Map<string, DiffOccurrence> {
  const out = new Map<string, DiffOccurrence>();
  const group = (docs: string[]): Map<string, string[]> => {
    const g = new Map<string, string[]>();
    for (const d of docs) {
      const src = sourcePath(d) ?? "?";
      const arr = g.get(src);
      if (arr === undefined) g.set(src, [d]);
      else arr.push(d);
    }
    return g;
  };
  const groupsA = group(splitDocuments(a));
  const groupsB = group(splitDocuments(b));

  for (const [src, docsA] of groupsA) {
    const docsB = groupsB.get(src) ?? [];
    for (let ord = 0; ord < docsA.length; ord++) {
      const docA = docsA[ord];
      const docB = docsB[ord];
      const linesA = docA.split("\n");
      const differing =
        docB === undefined
          ? linesA.map((_, i) => i)
          : diffDocLines(linesA, docB.split("\n"));
      if (differing.length === 0) continue;
      const docKey = `${src}#${ord}`;
      const docId = docIdOf(docA);
      const keyCounts = new Map<string, number>();
      for (const i of differing) {
        const key = lineKeyOf(linesA[i], i);
        const n = keyCounts.get(key) ?? 0;
        keyCounts.set(key, n + 1);
        out.set(`${docKey}\u0000${key}\u0000${n}`, {
          ident: `${docKey}\u0000${key}\u0000${n}`,
          doc: src,
          docId,
          key,
          line: i + 1,
        });
      }
    }
  }
  return out;
}

// --- static pin-candidate discovery ----------------------------------------

/**
 * Values paths that, set truthy, make `expr` FALSE — closing a gate the
 * generator sits behind. Only shapes a single string pin can definitively
 * close are extracted: `not .Values.x` and `and`-conjunctions of them.
 */
function closingPins(node: ExprNode | undefined): string[] {
  if (node === undefined) return [];
  if (node.type === "call") {
    if (node.op === "not" && node.args.length === 1) return openingPins(node.args[0]);
    if (node.op === "and") return node.args.flatMap((a) => closingPins(a));
    if (node.op === "or" && node.args.length === 1) return closingPins(node.args[0]);
  }
  return [];
}

/** Values paths that, set truthy, make `expr` TRUE — killing an else branch. */
function openingPins(node: ExprNode | undefined): string[] {
  if (node === undefined) return [];
  if (node.type === "atom" && node.token.t === "word") {
    const m = node.token.v.match(/^\$?\.Values((?:\.[A-Za-z0-9_-]+)+)$/);
    return m ? [m[1].slice(1)] : [];
  }
  if (node.type === "call") {
    if (node.op === "or") return node.args.flatMap((a) => openingPins(a));
    if (node.op === "and" && node.args.length === 1) return openingPins(node.args[0]);
    if (node.op === "not" && node.args.length === 1) return closingPins(node.args[0]);
  }
  return [];
}

const STYLE_RANK: Record<PinStyle, number> = { supply: 0, "existing-slot": 1, gate: 2 };

function styleOfGatePath(path: string): PinStyle {
  return /existing/i.test(path.split(".").pop() ?? "") ? "existing-slot" : "gate";
}

// --- chart scanning (define/include graph) ---------------------------------

interface FileScan {
  /** Root-relative file path (matches classifier report coordinates). */
  file: string;
  instance: ChartInstance;
  scoped: ScopedAction[];
  /** Innermost enclosing `define`/`block` name per action, when named. */
  containingDefine: (string | undefined)[];
}

interface ChartScan {
  files: Map<string, FileScan>;
  /** define name -> include sites (file + action index). */
  includeSites: Map<string, { file: string; index: number }[]>;
}

const INCLUDE_RE = /(?:include|template)\s+"([^"]+)"/g;
const DEFINE_NAME_RE = /^(?:define|block)\s+"([^"]+)"/;

function scanChart(chartDir: string, supplied: unknown): ChartScan {
  const { instances } = buildChartInstances(chartDir, supplied);
  const files = new Map<string, FileScan>();
  const includeSites = new Map<string, { file: string; index: number }[]>();
  const seenDirs = new Set<string>();

  for (const instance of instances) {
    // Aliased dependencies scan the same directory twice; the first
    // instance's scope stands in for both (pin paths differ per alias, but
    // the FILES exist once — same convention the classifier uses).
    if (seenDirs.has(instance.dir)) continue;
    seenDirs.add(instance.dir);

    for (const abs of collectOwnTemplateFiles(instance.dir).sort()) {
      const rel = abs.slice(instance.dir.length + 1);
      const file = instance.relDir === "" ? rel : `${instance.relDir}/${rel}`;
      const scoped = scopeActions(extractActions(readFileSync(abs, "utf8"), file));

      // Track the enclosing define per action: define/block/if/with/range
      // push, end pops — mirroring scopeActions' stack discipline.
      const stack: (string | undefined)[] = [];
      const containingDefine: (string | undefined)[] = [];
      for (let i = 0; i < scoped.length; i++) {
        const action = scoped[i].action;
        const nearest = (): string | undefined => {
          for (let s = stack.length - 1; s >= 0; s--) {
            if (stack[s] !== undefined) return stack[s];
          }
          return undefined;
        };
        switch (action.kind) {
          case "define":
          case "block": {
            containingDefine.push(nearest());
            stack.push(action.body.match(DEFINE_NAME_RE)?.[1]);
            break;
          }
          case "if":
          case "with":
          case "range":
            containingDefine.push(nearest());
            stack.push(undefined);
            break;
          case "end":
            stack.pop();
            containingDefine.push(nearest());
            break;
          default:
            containingDefine.push(nearest());
        }
        for (const m of action.body.matchAll(INCLUDE_RE)) {
          const sites = includeSites.get(m[1]);
          const site = { file, index: i };
          if (sites === undefined) includeSites.set(m[1], [site]);
          else sites.push(site);
        }
      }
      files.set(file, { file, instance, scoped, containingDefine });
    }
  }
  return { files, includeSites };
}

/**
 * Candidate pins for one scoped action: gates from enclosing frames
 * (closing a condition, or satisfying an else branch's negated condition),
 * scoped into root coordinates.
 */
function pinsForAction(scan: FileScan, index: number): CandidatePin[] {
  const out: CandidatePin[] = [];
  const scope = scan.instance.scope;
  const scopePath = (rel: string): string => [...scope, rel].join(".");
  for (const frame of scan.scoped[index].frames) {
    for (const cond of frame.conditions) {
      for (const p of closingPins(parseExpr(cond))) {
        out.push({ path: scopePath(p), style: styleOfGatePath(p) });
      }
    }
    for (const neg of frame.negatedConditions) {
      // The else branch of `if .Values.x` runs the generator; supplying x
      // is the supply-style pin — the value that replaces the generated one.
      for (const p of openingPins(parseExpr(neg))) {
        out.push({ path: scopePath(p), style: "supply" });
      }
    }
  }
  return out;
}

/**
 * All candidate pins for a generator site, walking the include chain: a
 * generator inside a define inherits the gates of every include site of
 * that define, recursively (bounded).
 */
function candidatesForSite(
  scan: ChartScan,
  site: ClosedInput,
  rootValues: unknown,
): CandidatePin[] {
  const collected: CandidatePin[] = [];
  if (site.suppliable === true && site.valuesPath !== undefined) {
    collected.push({ path: site.valuesPath, style: "supply" });
  }

  const fileScan = site.file !== undefined ? scan.files.get(site.file) : undefined;
  if (fileScan !== undefined) {
    const fnRe = new RegExp(`(?<![.\\w$])${site.fn}\\b`);
    const index = fileScan.scoped.findIndex(
      (s) => s.action.line === site.line && fnRe.test(s.action.body),
    );
    if (index !== -1) {
      const visitedDefines = new Set<string>();
      const visit = (fs: FileScan, actionIndex: number, depth: number): void => {
        collected.push(...pinsForAction(fs, actionIndex));
        if (depth >= 4) return;
        const define = fs.containingDefine[actionIndex];
        if (define === undefined || visitedDefines.has(define)) return;
        visitedDefines.add(define);
        for (const inc of scan.includeSites.get(define) ?? []) {
          const incScan = scan.files.get(inc.file);
          if (incScan !== undefined) visit(incScan, inc.index, depth + 1);
        }
      };
      visit(fileScan, index, 0);
    }
  }

  // Dedupe by path (strongest style wins); drop pins that cannot change the
  // render: already-truthy values (the gate would already be closed) and
  // structured values (a string pin would corrupt them).
  const byPath = new Map<string, CandidatePin>();
  for (const pin of collected) {
    const current = valueAtPath(rootValues, pin.path.split("."));
    if (current !== undefined && current !== null) {
      if (typeof current === "object") continue;
      if (current !== "" && current !== false && current !== 0) continue;
    }
    const existing = byPath.get(pin.path);
    if (existing === undefined || STYLE_RANK[pin.style] < STYLE_RANK[existing.style]) {
      byPath.set(pin.path, pin);
    }
  }
  return [...byPath.values()].sort((a, b) => STYLE_RANK[a.style] - STYLE_RANK[b.style]);
}

// --- localization ----------------------------------------------------------

function suggestedPinFor(pin: CandidatePin): string {
  switch (pin.style) {
    case "supply":
      return `${pin.path}: <generate once and supply>`;
    case "existing-slot":
      return `${pin.path}: <existing Secret name>`;
    case "gate":
      return `${pin.path}: <supply to disable in-template generation>`;
  }
}

/**
 * Localize the open generated inputs of a chart: double-render, and map
 * every differing line back to the input that produced it by pinning
 * candidate inputs one at a time. See the module doc for the mechanism.
 */
export function localizeOpenInputs(
  chartDir: string,
  report: PinnabilityReport,
  options: LocalizeOptions,
): LocalizationReport {
  let supplied: unknown;
  for (const file of options.valuesFiles ?? []) {
    supplied = mergeValues(supplied ?? {}, readYamlFile(file));
  }
  if (options.values !== undefined) supplied = mergeValues(supplied ?? {}, options.values);

  let renders = 0;
  const probeCache = new Map<string, Map<string, DiffOccurrence>>();
  const probe = (pins: Record<string, string>): Map<string, DiffOccurrence> => {
    const key = JSON.stringify(Object.entries(pins).sort());
    const cached = probeCache.get(key);
    if (cached !== undefined) return cached;
    const a = options.render(pins);
    const b = options.render(pins);
    renders += 2;
    const diff = diffRenderPair(a, b);
    probeCache.set(key, diff);
    return diff;
  };

  const base = probe({});
  const sites = report.closedInputs.filter(
    (c): c is ClosedInput & { fn: string; file: string; line: number } =>
      c.kind === "generated-value" &&
      c.fn !== undefined &&
      c.file !== undefined &&
      c.line !== undefined,
  );

  const inputs: LocalizedInput[] = sites.map((s) => ({
    fn: s.fn,
    file: s.file,
    line: s.line,
    valuesPath: undefined,
    suppliable: false,
    suggestedPin: undefined,
    existingSlots: [],
    occurrences: [],
  }));

  if (base.size === 0) {
    // Deterministic: the statically-named inputs did not fire. Report them
    // with their static supply paths and no occurrences; no probes needed.
    for (let i = 0; i < sites.length; i++) {
      if (sites[i].suppliable === true && sites[i].valuesPath !== undefined) {
        inputs[i].valuesPath = sites[i].valuesPath;
        inputs[i].suppliable = true;
        inputs[i].suggestedPin = suggestedPinFor({
          path: sites[i].valuesPath as string,
          style: "supply",
        });
      }
    }
    return {
      deterministic: true,
      differingLines: 0,
      inputs,
      unlocalized: [],
      renders,
    };
  }

  const rootValues = mergeValues(readYamlFile(`${chartDir}/values.yaml`) ?? {}, supplied);
  const scan = scanChart(chartDir, supplied);
  const maxProbes = options.maxProbesPerInput ?? 6;

  const attributed = new Set<string>();
  const attributedTo = new Map<number, Set<string>>();
  const bestPin: (CandidatePin | undefined)[] = new Array(sites.length).fill(undefined);

  const attribute = (siteIndex: number, ident: string): void => {
    let set = attributedTo.get(siteIndex);
    if (set === undefined) {
      set = new Set();
      attributedTo.set(siteIndex, set);
    }
    set.add(ident);
    attributed.add(ident);
  };

  // Phase A — individual pin probes. A pin validates when it stabilizes at
  // least one base-differing line; those lines belong to its site.
  for (let i = 0; i < sites.length; i++) {
    const cands = candidatesForSite(scan, sites[i], rootValues);
    let probes = 0;
    for (const cand of cands) {
      if (probes >= maxProbes) break;
      // Plain gates are a last resort: once any pin validated, only probe
      // remaining supply/existing-slot candidates (they name user slots).
      if (cand.style === "gate" && bestPin[i] !== undefined) continue;
      probes += 1;
      const pinned = probe({ [cand.path]: PROBE_VALUE });
      const stabilized = [...base.keys()].filter((id) => !pinned.has(id));
      if (stabilized.length === 0) continue;
      for (const id of stabilized) attribute(i, id);
      if (cand.style === "existing-slot") inputs[i].existingSlots.push(cand.path);
      if (
        bestPin[i] === undefined ||
        STYLE_RANK[cand.style] < STYLE_RANK[(bestPin[i] as CandidatePin).style]
      ) {
        bestPin[i] = cand;
      }
    }
    if (bestPin[i] !== undefined) {
      const pin = bestPin[i] as CandidatePin;
      inputs[i].suppliable = true;
      inputs[i].suggestedPin = suggestedPinFor(pin);
      if (pin.style === "supply") inputs[i].valuesPath = pin.path;
    }
  }

  // Phase B — per-file joint probes for cascades with several roots: a
  // checksum over a secret carrying two generated values stabilizes only
  // when BOTH are pinned, so it attributes to every generator of that file.
  const byFile = new Map<string, number[]>();
  for (let i = 0; i < sites.length; i++) {
    if (bestPin[i] === undefined) continue;
    const arr = byFile.get(sites[i].file);
    if (arr === undefined) byFile.set(sites[i].file, [i]);
    else arr.push(i);
  }
  if ([...attributed].length < base.size) {
    for (const members of byFile.values()) {
      if (members.length < 2) continue;
      const pins: Record<string, string> = {};
      for (const i of members) pins[(bestPin[i] as CandidatePin).path] = PROBE_VALUE;
      const pinned = probe(pins);
      for (const id of base.keys()) {
        if (attributed.has(id) || pinned.has(id)) continue;
        for (const i of members) attribute(i, id);
      }
    }
  }

  // Phase C — all validated pins at once: confirms that closing every
  // localized input closes the chart, and catches cross-file joint cascades.
  let stableWithAllPins: boolean | undefined;
  const pinnedSites = bestPin.flatMap((p, i) => (p === undefined ? [] : [i]));
  if (pinnedSites.length > 0) {
    const pins: Record<string, string> = {};
    for (const i of pinnedSites) pins[(bestPin[i] as CandidatePin).path] = PROBE_VALUE;
    const finalDiff = probe(pins);
    stableWithAllPins = finalDiff.size === 0;
    for (const id of base.keys()) {
      if (attributed.has(id) || finalDiff.has(id)) continue;
      for (const i of pinnedSites) attribute(i, id);
    }
  }

  // Phase D — source fallback for sites no pin can close (a genCA behind an
  // include-computed gate): a differing line in a document rendered FROM the
  // generator's own template maps to it without a probe.
  for (const [id, occ] of base) {
    if (attributed.has(id)) continue;
    for (let i = 0; i < sites.length; i++) {
      if (sites[i].file === occ.doc) attribute(i, id);
    }
  }

  const toOccurrence = (occ: DiffOccurrence, derived: boolean): LocalizedOccurrence => ({
    doc: occ.doc,
    docId: occ.docId,
    key: occ.key,
    line: occ.line,
    derived,
  });
  const unlocalized: LocalizedOccurrence[] = [];
  for (const [id, occ] of base) {
    if (!attributed.has(id)) {
      unlocalized.push(toOccurrence(occ, false));
    }
  }
  for (let i = 0; i < sites.length; i++) {
    const ids = attributedTo.get(i);
    if (ids === undefined) continue;
    inputs[i].occurrences = [...ids]
      .map((id) => base.get(id) as DiffOccurrence)
      .sort((a, b) => (a.doc === b.doc ? a.line - b.line : a.doc < b.doc ? -1 : 1))
      .map((occ) => toOccurrence(occ, occ.doc !== sites[i].file));
  }

  return {
    deterministic: false,
    differingLines: base.size,
    inputs,
    unlocalized,
    stableWithAllPins,
    renders,
  };
}
