/**
 * `collectorAudit`: the otel lexicon's pins against what upstream has
 * released since (#3369), the activity behind `CollectorAuditOp`.
 *
 * Three readings, each against a moving upstream:
 *
 * - the contrib release list against `COLLECTOR_PIN`: how many releases
 *   the pin is behind, and the newest one.
 * - component stability from each built-in component's `metadata.yaml`, at
 *   the pin and at the newest release: a signal whose stability level
 *   changed between the two, and any signal that is `deprecated` or
 *   `unmaintained` at the newest release. A component's file is looked up
 *   in contrib, then in core, at `<kind>/<type><kind>/metadata.yaml`; one
 *   found in neither is listed as unchecked, never as a finding.
 * - `GENAI_SEMCONV_PIN` against the semantic-conventions releases.
 *
 * `mode` says what to do with the findings: `report` returns them;
 * `issue` keeps one open issue current; `pull-request` also bumps the pins
 * in the lexicon's `src/define.ts` on a proposal branch and opens (or
 * edits) a pull request with the findings as its body. Only the pin values
 * change: the config types written against the old pin are the reviewer's
 * to move, which the body says.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { load } from "js-yaml";
import { COLLECTOR_PIN, GENAI_SEMCONV_PIN, type ComponentClass } from "../../define";
import * as components from "../../components";
import type { ComponentKind } from "../../model";
import { compareSemver, defaultRunner, fetchReleases, proposePullRequest, stickyIssue, type CommandRunner, type Release } from "./github";

export type CollectorAuditMode = "report" | "issue" | "pull-request";

export const CONTRIB_REPO = "open-telemetry/opentelemetry-collector-contrib";
export const CORE_REPO = "open-telemetry/opentelemetry-collector";
export const SEMCONV_REPO = "open-telemetry/semantic-conventions";

export interface CollectorAuditArgs {
  mode?: CollectorAuditMode;
  /**
   * The otel lexicon's directory, whose `src/define.ts` a pull request
   * edits. Default `<cwd>/lexicons/otel`.
   */
  lexiconDir?: string;
  /** Check component stability. Default true. */
  stability?: boolean;
  /** At most this many `metadata.yaml` reads. Default 200. */
  stabilityBudget?: number;
  /** The proposal branch. Default `chant/otel-pins`. */
  branch?: string;
  /** Replaces fetch. For tests. */
  _fetch?: typeof fetch;
  /** Replaces git and gh. For tests. */
  _run?: CommandRunner;
}

export type CollectorAuditFindingKind = "collector-pin-behind" | "semconv-pin-behind" | "stability-changed" | "deprecated";

export interface CollectorAuditFinding {
  kind: CollectorAuditFindingKind;
  /** The pin or the component (`receiver/otlp`) the finding is about. */
  subject: string;
  detail: string;
}

export interface CollectorAuditResult {
  mode: CollectorAuditMode;
  collector: { pin: string; latest: string | null; behind: number };
  semconv: { pin: string; latest: string | null; behind: number };
  findings: CollectorAuditFinding[];
  /** Components whose metadata.yaml was in neither repository, or past the budget. */
  unchecked: string[];
  summary: string;
  issueUrl?: string;
  prUrl?: string;
}

/** A built-in component's kind and collector type. */
export interface BuiltinComponent {
  kind: ComponentKind;
  type: string;
}

export function builtinComponents(): BuiltinComponent[] {
  const out: BuiltinComponent[] = [];
  const seen = new Set<string>();
  for (const value of Object.values(components) as unknown[]) {
    if (typeof value !== "function") continue;
    const def = (value as Partial<ComponentClass>).definition;
    if (!def || !def.builtin || typeof def.type !== "string") continue;
    const key = `${def.kind}/${def.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: def.kind, type: def.type });
  }
  return out.sort((a, b) => `${a.kind}/${a.type}`.localeCompare(`${b.kind}/${b.type}`));
}

/** The directory a component lives in upstream: `receiver/k8s_cluster` is `receiver/k8sclusterreceiver`. */
export function componentDir(c: BuiltinComponent): string {
  return `${c.kind}/${c.type.replace(/_/g, "")}${c.kind}`;
}

/** Stability level by signal, from a `metadata.yaml`'s `status.stability`. */
export type Stability = Record<string, string>;

export function parseStability(text: string): Stability | undefined {
  let doc: unknown;
  try {
    doc = load(text);
  } catch {
    return undefined;
  }
  const status = (doc as { status?: { stability?: unknown } } | undefined)?.status;
  const stability = status?.stability;
  if (!stability || typeof stability !== "object") return undefined;
  const out: Stability = {};
  for (const [level, signals] of Object.entries(stability as Record<string, unknown>)) {
    for (const s of Array.isArray(signals) ? signals : []) if (typeof s === "string") out[s] = level;
  }
  return out;
}

async function fetchText(f: typeof fetch, url: string): Promise<string | undefined> {
  const res = await f(url);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/** A component's stability at `tag`, from contrib or core; undefined when neither has its metadata.yaml. */
async function stabilityAt(f: typeof fetch, c: BuiltinComponent, tag: string, budget: { left: number }): Promise<Stability | undefined> {
  for (const repo of [CONTRIB_REPO, CORE_REPO]) {
    if (budget.left <= 0) return undefined;
    budget.left--;
    const text = await fetchText(f, `https://raw.githubusercontent.com/${repo}/${tag}/${componentDir(c)}/metadata.yaml`);
    if (text !== undefined) return parseStability(text);
  }
  return undefined;
}

const RETIRED = new Set(["deprecated", "unmaintained"]);

/** Findings for one component, from its stability at the pin and at the newest release. */
export function stabilityFindings(c: BuiltinComponent, atPin: Stability | undefined, atLatest: Stability, pin: string, latest: string): CollectorAuditFinding[] {
  const subject = `${c.kind}/${c.type}`;
  const out: CollectorAuditFinding[] = [];
  const retired = Object.entries(atLatest).filter(([, level]) => RETIRED.has(level));
  if (retired.length > 0) {
    out.push({ kind: "deprecated", subject, detail: `${retired.map(([s, l]) => `${s} ${l}`).join(", ")} at ${latest}` });
  }
  if (atPin && pin !== latest) {
    const changed = [...new Set([...Object.keys(atPin), ...Object.keys(atLatest)])]
      .filter((s) => atPin[s] !== atLatest[s] && !RETIRED.has(atLatest[s] ?? ""))
      .map((s) => `${s} ${atPin[s] ?? "absent"} to ${atLatest[s] ?? "absent"}`);
    if (changed.length > 0) out.push({ kind: "stability-changed", subject, detail: `${changed.join(", ")} (${pin} to ${latest})` });
  }
  return out;
}

function behindCount(releases: Release[], pin: string): number {
  return releases.filter((r) => compareSemver(r.tag, pin) > 0).length;
}

/** `src/define.ts` with `COLLECTOR_PIN` and `GENAI_SEMCONV_PIN` moved to the given versions. */
export function bumpPins(text: string, to: { collector?: string; genai?: string }): string {
  let out = text;
  const bump = (name: string, version: string) => {
    const re = new RegExp(`(export const ${name}: SchemaPin = Object\\.freeze\\(\\{[^}]*?version:\\s*")([^"]+)(")`);
    if (!re.test(out)) throw new Error(`define.ts has no ${name} with a version to bump`);
    out = out.replace(re, `$1${version}$3`);
  };
  if (to.collector) bump("COLLECTOR_PIN", to.collector);
  if (to.genai) bump("GENAI_SEMCONV_PIN", to.genai);
  return out;
}

export function renderCollectorAuditSummary(r: Omit<CollectorAuditResult, "summary" | "mode">): string {
  let out = "## Collector audit\n\n";
  out += `- COLLECTOR_PIN ${r.collector.pin}: ${r.collector.latest === null ? "release list unreadable" : r.collector.behind === 0 ? "current" : `${r.collector.behind} release(s) behind ${r.collector.latest}`}\n`;
  out += `- GENAI_SEMCONV_PIN ${r.semconv.pin}: ${r.semconv.latest === null ? "release list unreadable" : r.semconv.behind === 0 ? "current" : `${r.semconv.behind} release(s) behind ${r.semconv.latest}`}\n`;
  const comps = r.findings.filter((f) => f.kind === "deprecated" || f.kind === "stability-changed");
  if (comps.length > 0) {
    out += "\n| Component | Finding | Detail |\n|---|---|---|\n";
    for (const f of comps) out += `| ${f.subject} | ${f.kind} | ${f.detail} |\n`;
  } else {
    out += "\nNo component stability findings.\n";
  }
  if (r.unchecked.length > 0) out += `\nUnchecked (no metadata.yaml found, or past the budget): ${r.unchecked.join(", ")}\n`;
  return out;
}

/** Audit the otel lexicon's pins and its built-in components against upstream releases. */
export async function collectorAudit(args: CollectorAuditArgs = {}): Promise<CollectorAuditResult> {
  const f = args._fetch ?? fetch;
  const run = args._run ?? defaultRunner;
  const mode = args.mode ?? "report";
  const findings: CollectorAuditFinding[] = [];
  const unchecked: string[] = [];

  const contrib = await fetchReleases(CONTRIB_REPO, f).catch(() => null);
  const semconv = await fetchReleases(SEMCONV_REPO, f).catch(() => null);
  const collector = { pin: COLLECTOR_PIN.version, latest: contrib?.[0]?.tag ?? null, behind: contrib ? behindCount(contrib, COLLECTOR_PIN.version) : 0 };
  const sem = { pin: GENAI_SEMCONV_PIN.version, latest: semconv?.[0]?.tag ?? null, behind: semconv ? behindCount(semconv, GENAI_SEMCONV_PIN.version) : 0 };
  if (collector.latest && collector.behind > 0) {
    findings.push({ kind: "collector-pin-behind", subject: "COLLECTOR_PIN", detail: `${collector.pin} is ${collector.behind} release(s) behind ${collector.latest}` });
  }
  if (sem.latest && sem.behind > 0) {
    findings.push({ kind: "semconv-pin-behind", subject: "GENAI_SEMCONV_PIN", detail: `${sem.pin} is ${sem.behind} release(s) behind ${sem.latest}` });
  }

  if (args.stability !== false) {
    const latest = collector.latest ?? collector.pin;
    const budget = { left: args.stabilityBudget ?? 200 };
    for (const c of builtinComponents()) {
      const atLatest = await stabilityAt(f, c, latest, budget).catch(() => undefined);
      if (!atLatest) {
        unchecked.push(`${c.kind}/${c.type}`);
        continue;
      }
      const atPin = latest === collector.pin ? atLatest : await stabilityAt(f, c, collector.pin, budget).catch(() => undefined);
      findings.push(...stabilityFindings(c, atPin, atLatest, collector.pin, latest));
    }
  }

  const base = { collector, semconv: sem, findings, unchecked };
  const summary = renderCollectorAuditSummary(base);
  const result: CollectorAuditResult = { mode, ...base, summary };
  if (findings.length === 0 || mode === "report") return result;

  const cwd = process.cwd();
  if (mode === "issue") {
    result.issueUrl = await stickyIssue(run, cwd, "otel: collector audit findings", summary);
    return result;
  }

  // pull-request: bump the pins that are behind.
  const to = {
    ...(collector.latest && collector.behind > 0 ? { collector: collector.latest } : {}),
    ...(sem.latest && sem.behind > 0 ? { genai: sem.latest } : {}),
  };
  if (!to.collector && !to.genai) {
    result.issueUrl = await stickyIssue(run, cwd, "otel: collector audit findings", summary);
    return result;
  }
  const lexiconDir = resolve(args.lexiconDir ?? join(cwd, "lexicons", "otel"));
  const root = (await run("git", ["rev-parse", "--show-toplevel"], lexiconDir)).trim();
  const definePath = join(lexiconDir, "src", "define.ts");
  const content = bumpPins(readFileSync(definePath, "utf8"), to);
  const moved = [to.collector ? `COLLECTOR_PIN to ${to.collector}` : "", to.genai ? `GENAI_SEMCONV_PIN to ${to.genai}` : ""].filter(Boolean).join(" and ");
  result.prUrl = await proposePullRequest(run, {
    root,
    branch: args.branch ?? "chant/otel-pins",
    title: `chore(otel): move ${moved}`,
    body:
      `${summary}\n\nThis moves the pin values only. The config types, defaults and checks written against ${collector.pin} ` +
      "still need reading against the release notes before this merges.\n",
    files: [{ path: relative(root, definePath), content }],
    commitMessage: `chore(otel): move ${moved}`,
    worktreeDir: join(mkdtempSync(join(tmpdir(), "chant-otel-pins-")), "wt"),
  });
  return result;
}
