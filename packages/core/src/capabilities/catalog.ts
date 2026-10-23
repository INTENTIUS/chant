/**
 * The capability catalog (#4375): the rule files core ships, the packs
 * lexicons contribute, and the engine that evaluates one over a graph.
 *
 * Rules are data: `aws.paths` beside this module, read at run time. It serves
 * every lexicon that maps AWS resources onto the view (the aws lexicon's
 * CloudFormation kinds and the terraform lexicon's AWS provider types), so it
 * lives here rather than in either lexicon. Each lexicon ships its mapping
 * (data) and, where it needs one, an adapter (code), as a `CapabilityPack` on
 * its plugin.
 */
import { readFileSync } from "node:fs";
import type { GraphIR } from "../graph-ir";
import { parseRules, ruleDependencies, type Literal, type Rule } from "./language";
import { CapabilityEngine } from "./matcher";
import { buildView, mergeMappings, type CapabilityMapping, type CapabilityPack, type View } from "./view";
import base from "./base-mappings.json" with { type: "json" };

/** The rule files core ships, by name. */
const RULE_FILES = ["aws.paths"] as const;

let rulesCache: { rules: Rule[]; sources: Map<string, string> } | undefined;

/** Every rule core ships, parsed, with the file each came from. */
export function shippedRules(): { rules: Rule[]; sources: Map<string, string> } {
  if (rulesCache) return rulesCache;
  const rules: Rule[] = [];
  const sources = new Map<string, string>();
  for (const file of RULE_FILES) {
    const text = readFileSync(new URL(`./${file}`, import.meta.url), "utf-8");
    for (const r of parseRules(text)) {
      rules.push(r);
      sources.set(r.name, file);
    }
  }
  rulesCache = { rules, sources };
  return rulesCache;
}

/** The mappings core's folds need, for a graph read without its lexicon's plugin. */
export function basePacks(): CapabilityPack[] {
  return (base as unknown as { mappings: CapabilityMapping[] }).mappings.map((mapping) => ({ mapping }));
}

const registered: CapabilityPack[] = [];

/**
 * Register a lexicon's pack for callers that hold no plugin list (the folds,
 * a test). A plugin's `capabilityPack` reaches search without this.
 */
export function registerCapabilityPack(pack: CapabilityPack): void {
  if (!registered.includes(pack)) registered.push(pack);
}

/** Base packs, registered packs, then the packs given: later ones extend earlier ones. */
export function resolvePacks(packs: CapabilityPack[] = []): CapabilityPack[] {
  return [...basePacks(), ...registered, ...packs.filter((p) => !registered.includes(p))];
}

const engines = new WeakMap<GraphIR, CapabilityEngine>();

/**
 * The capability engine for a graph, built once per graph object. Packs
 * passed on the first call for a graph are the ones it uses.
 */
export function capabilityEngine(ir: GraphIR, packs: CapabilityPack[] = []): CapabilityEngine {
  let e = engines.get(ir);
  if (!e) {
    e = new CapabilityEngine(buildView(ir, resolvePacks(packs)), shippedRules().rules);
    engines.set(ir, e);
  }
  return e;
}

/** Bind a graph to the packs its search was given, before anything asks for a capability. */
export function attachCapabilities(ir: GraphIR, packs: CapabilityPack[]): CapabilityEngine {
  engines.delete(ir);
  return capabilityEngine(ir, packs);
}

/**
 * Bind a graph to a view built elsewhere (#4378): a workspace's composed
 * view, which each member's own chant mapped. The rules are this chant's.
 */
export function attachView(ir: GraphIR, view: View): CapabilityEngine {
  const e = new CapabilityEngine(view, shippedRules().rules);
  engines.set(ir, e);
  return e;
}

/**
 * Read `name` or `name(arg, ...)`, as a search term or an edge qualifier
 * spells a capability. An argument is a number, `true`/`false`, or text,
 * quoted or not.
 */
export function parseCapabilityCall(text: string): { name: string; args: (Literal | undefined)[] } | undefined {
  const m = /^([A-Za-z_][\w-]*)(?:\((.*)\))?$/.exec(text.trim());
  if (!m) return undefined;
  const args = m[2] === undefined || m[2].trim() === ""
    ? []
    : m[2].split(",").map((a) => {
        const s = a.trim();
        if (s === "" || s === "_") return undefined;
        if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
        if (s === "true" || s === "false") return s === "true";
        return s.replace(/^"(.*)"$/, "$1");
      });
  return { name: m[1], args };
}

/** Public capabilities: those whose rule carries a `## meaning`. Helpers carry none. */
export function isPublic(rule: Rule): boolean {
  return rule.meta.meaning !== undefined;
}

/** Every label a rule needs, through the capabilities it uses, per alternative: any one alternative suffices. */
function labelsNeeded(rule: Rule, byName: Map<string, Rule>, seen = new Set<string>()): string[][] {
  if (seen.has(rule.name)) return [[]];
  seen.add(rule.name);
  const out: string[][] = [];
  for (const alt of rule.alts) {
    // A node of any one of its labels will do, so each label is an option.
    let options: string[][] = alt.head.labels ? alt.head.labels.map((l) => [l]) : [[]];
    const add = (more: string[][]): void => {
      options = options.flatMap((o) => more.map((m) => [...o, ...m]));
    };
    for (const t of alt.head.tests) if (t.kind === "cap" && !t.negated) add(labelsNeeded(byName.get(t.cap)!, byName, new Set(seen)));
    for (const s of alt.steps) {
      if (s.negated) continue;
      if (s.node.labels && s.min > 0) add(s.node.labels.map((l) => [l]));
      for (const t of s.node.tests) if (t.kind === "cap" && !t.negated) add(labelsNeeded(byName.get(t.cap)!, byName, new Set(seen)));
      if (s.min > 0) {
        const edgeRules = s.names.map((n) => byName.get(n.name)).filter((r): r is Rule => !!r);
        if (edgeRules.length === s.names.length) add(edgeRules.flatMap((r) => labelsNeeded(r, byName, new Set(seen))));
      }
    }
    out.push(...options);
  }
  return out;
}

/**
 * Whether a lexicon can supply a capability: its own statement when its
 * mapping makes one, otherwise whether every label one alternative needs
 * is one the mapping labels.
 */
export function lexiconSupport(
  rule: Rule,
  mapping: CapabilityMapping | undefined,
  lexicon: string,
): "supported" | { code: string; message: string } {
  if (!mapping) {
    return { code: "lexicon-has-no-mapping", message: `the ${lexicon} lexicon ships no capability mapping` };
  }
  const stated = mapping.unsupported?.[rule.name];
  if (stated) return stated;
  // A lexicon's mapping extends core's base mapping for it (the folds' kinds).
  const own = mapping;
  const baseFor = basePacks().find((p) => p.mapping.lexicon === own.lexicon)?.mapping;
  if (baseFor) mapping = mergeMappings(baseFor, own);
  const { rules } = shippedRules();
  const byName = new Map(rules.map((r) => [r.name, r]));
  const labels = new Set(
    Object.values(mapping.labels ?? {}).map((s) => (typeof s === "string" ? s : s.label)),
  );
  // Statements and inline blocks are the adapter's own nodes.
  labels.add("Statement");
  for (const specs of Object.values(mapping.blocks ?? {})) for (const b of specs) labels.add(b.label);
  const options = labelsNeeded(rule, byName);
  if (options.some((o) => o.every((l) => labels.has(l)))) return "supported";
  const missing = [...new Set(options.flatMap((o) => o.filter((l) => !labels.has(l))))];
  return {
    code: "capability-not-derivable",
    message: `the ${lexicon} mapping labels no ${missing.join(" or ")}`,
  };
}

/** The capabilities a rule uses, directly. */
export function usesOf(rule: Rule): string[] {
  const { rules } = shippedRules();
  const names = new Set(rules.map((r) => r.name));
  return [...ruleDependencies(rule)].filter((n) => names.has(n));
}

/** One capability as the `capabilities` document lists it (#4375). */
export interface CapabilityEntry {
  name: string;
  meaning: string;
  shape: "set" | "edge";
  params: { name: string; optional: boolean; meaning: string }[];
  /** The search term that asks for it: `cap:<name>` for a set, `->[cap=<name>]` for an edge. */
  search: string;
  answers: string[];
  depth: "declared" | "live" | "either";
  lexicons: Record<string, "supported" | { code: string; message: string }>;
  notEvaluated: string[];
  /** The capabilities and helpers its rule uses. */
  uses: string[];
  rule: string;
}

/**
 * The catalog as the `capabilities` document carries it: every public
 * capability, with whether each lexicon given can supply it, and the helper
 * rules they use. `lexicons` maps each lexicon to its mapping, or to
 * undefined when it ships none.
 */
export function capabilityCatalog(lexicons: Record<string, CapabilityMapping | undefined>): {
  capabilities: CapabilityEntry[];
  helpers: { name: string; rule: string }[];
} {
  const { rules } = shippedRules();
  const list = (s: string | undefined): string[] =>
    (s ?? "").split(/\n|;/).map((x) => x.trim()).filter(Boolean);
  const capabilities = rules.filter(isPublic).map((r): CapabilityEntry => ({
    name: r.name,
    meaning: r.meta.meaning,
    shape: r.vars.length === 1 ? "set" : "edge",
    params: r.params.map((p) => ({ name: p.name, optional: p.optional, meaning: r.meta[`param-${p.name}`] ?? "" })),
    search: r.vars.length === 1 ? `cap:${r.name}` : `->[cap=${r.name}]`,
    answers: (r.meta.answers ?? "").split("\n").map((x) => x.trim()).filter(Boolean),
    depth: (r.meta.depth ?? "declared") as CapabilityEntry["depth"],
    lexicons: Object.fromEntries(Object.entries(lexicons).map(([lex, m]) => [lex, lexiconSupport(r, m, lex)])),
    notEvaluated: list(r.meta["not-evaluated"]),
    uses: usesOf(r),
    rule: r.text,
  }));
  const helpers = rules.filter((r) => !isPublic(r)).map((r) => ({ name: r.name, rule: r.text }));
  return { capabilities, helpers };
}
