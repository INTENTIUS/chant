/**
 * `chant terraform report`: a run report from `show -json` of a saved plan, in
 * the `terragucci.report/v1` shape that behold's kiosk reads, for pipelines
 * that run plain `terraform`, `terragrunt`, `atmos` or `choudoufu` and have no
 * terragucci in them.
 *
 * It covers one composed run: a root whose only content is `module` calls
 * (choudoufu's composed root, chant#4419), planned and applied as one. Each
 * top-level module becomes one root of the report, with its part of the plan
 * taken as if it had planned alone (`module.<m>.` off every address), the way
 * terragucci's own composed run reports it.
 *
 * What it writes is the part of the v1 contract a reader needs to draw the
 * run: roots, their changes with before and after values, "known after
 * apply" for values the plan cannot know, one composed wave, the totals,
 * groups and named destroys, the index row, and each root's `reads`: the
 * `data "terraform_estate_outputs"` blocks that read another module's estate,
 * and, in an Atmos repo, the `!terraform.output` calls in its stack manifests,
 * which behold draws as the lines between roots. The estate of each module
 * comes from the `live` block in its directory (`<repo>/<root-dir>/<module>`),
 * since the plan holds none. After an apply, a second
 * `show -json` (of a plan made once the apply finished, whose `prior_state`
 * holds the state) fills in the values the plan left unknown. It writes no
 * report.html, no plan files, no policy, cost or approval fields.
 *
 * The change set is {@link terraformChangeSetPart}'s, and the grouping is
 * chant's `groupChangeSet`, so a report here and one from terragucci agree on
 * what changed.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { changeSetDigest, composeChangeSet, type ChangeSetAction, type ChangeSetDocument, type ChangeSetAttribute, type ChangeSetEntry, type ChangeSetPlanner } from "@intentius/chant/change-set";
import { groupChangeSet } from "@intentius/chant/plan-summary";
import { plannerForBinary, terraformChangeSetPart } from "./change-set";
import { moduleChanges, stripModule, topModule } from "./compose/module-address";
import { stateResources } from "./applied-state";
import { isJsonConfigFile, jsonLiveBlocks, listConfigFiles } from "./hcl/files";

export { topModule } from "./compose/module-address";

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

export const REPORT_SCHEMA = "terragucci.report/v1";
export const INDEX_SCHEMA = "terragucci.report-index/v1";
/** The minor of the v1 contract the report is written to: `compose.estate` is minor 48. */
export const REPORT_MINOR = 48;
/** What terragucci puts in place of a redacted value; the report carries no values it would need to redact. */
export const REDACTED = "(sensitive, redacted by terragucci)";

export type ReportStage = "tf-plan" | "tf-apply";

export interface RunFacts {
  /** `<host>/<path>` of the repo, as terragucci names a project. */
  project: string;
  commit: string;
  job_url?: string;
  commit_url?: string;
  pull_request?: string;
  pull_request_url?: string;
}

/**
 * The run's facts from a Forgejo, Gitea or GitHub Actions environment
 * (`GITHUB_REPOSITORY`, `GITHUB_SERVER_URL`, `GITHUB_SHA`, `GITHUB_RUN_ID`,
 * which Forgejo sets too). `project` and `commit` override it; `pullRequest`
 * is the number, when the run has one.
 */
export function runFactsFromEnv(env: NodeJS.ProcessEnv, over: { pullRequest?: string; project?: string; commit?: string } = {}): RunFacts {
  const repo = env.GITHUB_REPOSITORY;
  const server = (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/+$/, "");
  const commit = over.commit ?? env.GITHUB_SHA;
  const project = over.project ?? (repo ? `${new URL(server).host}/${repo}` : undefined);
  if (!project || !commit) throw new Error("GITHUB_REPOSITORY and GITHUB_SHA are not set; pass --project and --commit");
  const web = repo ? `${server}/${repo}` : undefined;
  const forgejo = env.FORGEJO_ACTIONS === "true" || env.GITEA_ACTIONS === "true";
  const number = over.pullRequest && /^\d+$/.test(over.pullRequest.trim()) ? over.pullRequest.trim() : undefined;
  return {
    project,
    commit,
    ...(web && env.GITHUB_RUN_ID ? { job_url: `${web}/actions/runs/${env.GITHUB_RUN_ID}` } : {}),
    ...(web ? { commit_url: `${web}/commit/${commit}` } : {}),
    ...(web && number ? { pull_request: number, pull_request_url: `${web}/${forgejo ? "pulls" : "pull"}/${number}` } : number ? { pull_request: number } : {}),
  };
}

export interface TerraformReportInput {
  stage: ReportStage;
  /** `show -json` of the saved plan. */
  plan: unknown;
  /** tf-apply: `show -json` of a plan made after the apply. Its `prior_state` holds the applied values. */
  applied?: unknown;
  run: RunFacts;
  /** The binary that planned, by name or path. Default `terraform`. */
  binary?: string;
  /** The binary's version, when known. */
  binaryVersion?: string;
  /** Where each root lives in the repo: the root of module `network` is `<rootDir>/network`. Default: the module's name. */
  rootDir?: string;
  /** The path of the composed root itself, which holds any resource declared outside a module. Default: `rootDir`, else `.`. */
  selfRoot?: string;
  /**
   * The estate each module's directory names in its `live` block, by module:
   * what ties a `terraform_estate_outputs` read to the module that owns the
   * estate. The plan carries no `live` block, so {@link moduleEstates} reads it
   * from the directories. A read of an estate none of these names has no edge.
   */
  estates?: Record<string, string>;
  /**
   * What each module reads off the others' outputs through the stack that
   * wires them, by module: Atmos's `!terraform.output` ({@link atmosStackReads}).
   * Atmos resolves those into plain variables before the plan, so the plan
   * holds no trace of them. A module already read through an estate data
   * block is not read twice.
   */
  componentReads?: ComponentReads;
  started?: string;
  finished: string;
  runtime?: string;
}

export interface IndexRow {
  project: string;
  commit: string;
  stage: ReportStage;
  finished: string;
  path: string;
  roots: number;
  groups: number;
  totals: { create: number; update: number; replace: number; delete: number };
  refused: number;
  failed: number;
  changed: number;
  destroys: string[];
  applied?: string;
  commit_url?: string;
  pull_request?: string;
  pull_request_url?: string;
  job_url?: string;
}

// ---------------------------------------------------------------------------
// Slicing the composed plan into one plan per module.
// ---------------------------------------------------------------------------

/** The plan's `resource_changes` that belong to module `m` (undefined: the root's own), each with the module taken off its address. */
export function slicePlan(plan: unknown, m: string | undefined): Json {
  const p = isObject(plan) ? plan : {};
  return { ...(p.errored === true ? { errored: true } : {}), resource_changes: moduleChanges(p.resource_changes, m) };
}

// ---------------------------------------------------------------------------
// Applied values: the state after the apply gives the values the plan left unknown,
// read through `./applied-state`, as the composed estate run reads them.
// ---------------------------------------------------------------------------

/** Whether a sensitivity map marks anything under it `true`. */
function marks(v: unknown): boolean {
  if (v === true) return true;
  if (Array.isArray(v)) return v.some(marks);
  if (isObject(v)) return Object.values(v).some(marks);
  return false;
}

/** Each unknown attribute given the value the state holds. One the state lacks stays unknown; a sensitive one stays `sensitive`. */
function resolveUnknowns(attributes: ChangeSetAttribute[], res: { values: Json; sensitive: Json } | undefined): ChangeSetAttribute[] {
  if (!res || !attributes.some((a) => a.unknown)) return attributes;
  return attributes.map((a) => {
    if (!a.unknown) return a;
    const { unknown: _u, before: _b, after: _a, ...rest } = a;
    if (a.sensitive || marks(res.sensitive[a.path])) return { ...rest, sensitive: true as const };
    const value = res.values[a.path];
    if (value === undefined) return a;
    return { ...rest, ...(a.before !== undefined ? { before: a.before } : {}), after: value };
  });
}

// ---------------------------------------------------------------------------
// Reads: `data "terraform_estate_outputs"` blocks between the composed modules.
// ---------------------------------------------------------------------------

/** One `read` of the report schema's `reads`, as a composed run writes it. */
export interface ReportRead {
  upstream: string;
  data: string;
  outputs: "planned";
  unknown?: string[];
  /** Why the read is there, when no data block names it: Atmos's `!terraform.output` and the outputs it reads. */
  why?: string;
  composed: true;
}

/**
 * The estate named by the first `live { estate = "..." }` block in a
 * directory's configuration files, in filename order, or undefined. A `live`
 * block takes effect only under choudoufu, so the files are the ones
 * choudoufu reads (`.tf`, `.tf.json`, `.tofu` and `.tofu.json`, chant#4457)
 * unless `binary` names another. A JSON-syntax file's `live` block is the one
 * nested in its `terraform` block (chant#4504).
 */
export function estateOfDir(dir: string, binary = "choudoufu"): string | undefined {
  let files: string[];
  try {
    files = listConfigFiles(dir, binary);
  } catch {
    return undefined;
  }
  for (const f of files) {
    if (isJsonConfigFile(f)) {
      const estate = jsonLiveBlocks(readFileSync(join(dir, f), "utf8")).map((b) => b.estate).find((e): e is string => typeof e === "string" && e !== "");
      if (estate) return estate;
      continue;
    }
    const text = readFileSync(join(dir, f), "utf8").replace(/^\s*(#|\/\/).*$/gm, "");
    const live = /\blive\s*\{/.exec(text);
    if (!live) continue;
    const m = /\bestate\s*=\s*"([^"]+)"/.exec(text.slice(live.index + live[0].length));
    if (m) return m[1];
  }
  return undefined;
}

/** Each module's estate, read from `<repo>/<rootDir>/<module>`. A module whose directory has no `live` block is left out. */
export function moduleEstates(repo: string, rootDir: string, modules: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of modules) {
    const dir = join(repo, rootDir, m);
    const estate = existsSync(dir) ? estateOfDir(dir) : undefined;
    if (estate) out[m] = estate;
  }
  return out;
}

function anyUnknown(v: unknown): boolean {
  if (v === true) return true;
  if (Array.isArray(v)) return v.some(anyUnknown);
  if (isObject(v)) return Object.values(v).some(anyUnknown);
  return false;
}

/** The module's own configuration (`configuration.root_module.module_calls.<m>.module`), or undefined. */
function moduleConfig(plan: Json, m: string): Json | undefined {
  const root = isObject(plan.configuration) && isObject(plan.configuration.root_module) ? plan.configuration.root_module : {};
  const call = isObject(root.module_calls) ? root.module_calls[m] : undefined;
  return isObject(call) && isObject(call.module) ? call.module : undefined;
}

/** Every `references` string under an expression or a configuration. */
function references(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) references(x, out);
  else if (isObject(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (k === "references" && Array.isArray(x)) {
        for (const r of x) if (typeof r === "string") out.push(r);
      } else references(x, out);
    }
  }
  return out;
}

/**
 * The outputs of module `u` that the plan cannot know. Two sources, joined:
 * the composed root's own planned outputs (`<u>__<name>`, as terragucci's
 * composed root writes them), and each output of `u`'s configuration whose
 * expression refers to an attribute of a resource the plan leaves unknown.
 */
function unknownOutputsOf(plan: Json, u: string): Set<string> {
  const out = new Set<string>();
  const prefix = `${u}__`;
  if (isObject(plan.output_changes)) {
    for (const [k, c] of Object.entries(plan.output_changes)) if (k.startsWith(prefix) && isObject(c) && anyUnknown(c.after_unknown)) out.add(k.slice(prefix.length));
  } else if (isObject(plan.planned_values) && isObject(plan.planned_values.outputs)) {
    for (const [k, o] of Object.entries(plan.planned_values.outputs)) if (k.startsWith(prefix) && isObject(o) && !("value" in o)) out.add(k.slice(prefix.length));
  }
  const cfg = moduleConfig(plan, u);
  const outputs = cfg && isObject(cfg.outputs) ? cfg.outputs : {};
  const changes = (Array.isArray(plan.resource_changes) ? plan.resource_changes : []).filter((r): r is Json => isObject(r) && topModule(String(r.module_address ?? r.address ?? "")) === u);
  for (const [name, o] of Object.entries(outputs)) {
    for (const ref of references(o)) {
      const parts = ref.split(".");
      const data = parts[0] === "data";
      const [type, rname, attr] = data ? [parts[1], parts[2], parts[3]] : [parts[0], parts[1], parts[2]];
      if (!type || !rname) continue;
      const unprefixed = (c: Json): string => stripModule(String(c.address)).replace(/\[[^\]]*\]$/, "");
      for (const c of changes) {
        if (unprefixed(c) !== `${data ? "data." : ""}${type}.${rname}`) continue;
        const after = isObject(c.change) ? c.change.after_unknown : undefined;
        if (attr === undefined ? anyUnknown(after) : isObject(after) && anyUnknown(after[attr])) out.add(name);
      }
    }
  }
  return out;
}

const ESTATE_READ_TYPE = "terraform_estate_outputs";

/** The names a module reads off `data.terraform_estate_outputs.<name>.values`, or undefined when it reads the whole object. */
function valuesRead(refs: readonly string[], name: string): Set<string> | undefined {
  const re = new RegExp(`^data\\.${ESTATE_READ_TYPE}\\.${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.values\\.([A-Za-z_][\\w-]*)`);
  const read = new Set<string>();
  for (const r of refs) {
    const m = re.exec(r);
    if (m) read.add(m[1]!);
  }
  return read.size > 0 ? read : undefined;
}

/**
 * Module `m`'s reads of another module's estate, as terragucci writes them for
 * a composed run: `{ upstream, data, outputs: "planned", unknown?, composed }`.
 * `unknown` names the outputs it reads that the plan cannot know. A read of an
 * estate no other module owns has no edge and is left out.
 */
export function estateReads(plan: Json, m: string, estates: Readonly<Record<string, string>>, rootOf: (m: string | undefined) => string): ReportRead[] {
  const cfg = moduleConfig(plan, m);
  if (!cfg) return [];
  const refs = references(cfg);
  const reads: ReportRead[] = [];
  for (const r of Array.isArray(cfg.resources) ? cfg.resources : []) {
    if (!isObject(r) || r.mode !== "data" || r.type !== ESTATE_READ_TYPE || typeof r.name !== "string") continue;
    const expr = isObject(r.expressions) && isObject(r.expressions.estate) ? r.expressions.estate : undefined;
    const estate = expr && typeof expr.constant_value === "string" ? expr.constant_value : undefined;
    if (estate === undefined) continue;
    const upstream = Object.keys(estates).sort().find((o) => o !== m && estates[o] === estate);
    if (upstream === undefined) continue;
    const read = valuesRead(refs, r.name);
    const unknown = [...unknownOutputsOf(plan, upstream)].filter((n) => read === undefined || read.has(n)).sort();
    reads.push({ upstream: rootOf(upstream), data: r.name, outputs: "planned", ...(unknown.length ? { unknown } : {}), composed: true });
  }
  return reads;
}

// ---------------------------------------------------------------------------
// Reads: Atmos `!terraform.output` between the stack's components.
// ---------------------------------------------------------------------------

/** What each component reads off another with `!terraform.output`: reader -> upstream -> output names. */
export type ComponentReads = Record<string, Record<string, string[]>>;

const unquote = (s: string): string => s.replace(/^(["'])(.*)\1$/, "$2");

/**
 * Each component's `!terraform.output <component> [<stack>] <output>` reads in
 * one Atmos stack manifest. The components are the keys under
 * `components.terraform`, named by their `metadata.component` when they set
 * one. A line scan, not a YAML parser: Atmos writes the function as a tagged
 * scalar, one per line, which is all this reads.
 */
export function atmosOutputReads(yaml: string): ComponentReads {
  const path: { indent: number; key: string }[] = [];
  const found: { component: string; upstream: string; output: string }[] = [];
  const dirOf = new Map<string, string>();
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    const key = /^\s*(?:-\s+)?(["']?)([^"':#\s][^"':#]*?)\1\s*:(?:\s+(.*))?$/.exec(line);
    while (path.length && path[path.length - 1]!.indent >= indent) path.pop();
    const keys = path.map((p) => p.key);
    const at = keys.findIndex((k, i) => k === "components" && keys[i + 1] === "terraform");
    const component = at >= 0 ? keys[at + 2] : undefined;
    const value = key ? (key[3] ?? "") : line.trim().replace(/^-\s+/, "");
    if (key) {
      if (component !== undefined && keys.length === at + 4 && keys[at + 3] === "metadata" && key[2] === "component" && value) {
        dirOf.set(component, unquote(value.trim()));
      }
      path.push({ indent, key: key[2]! });
    }
    const call = /!terraform\.output\s+(.+)$/.exec(value);
    if (!call || component === undefined) continue;
    const args = call[1]!.trim().split(/\s+/).map(unquote);
    if (args.length < 2) continue;
    const output = /^\.?([A-Za-z_][\w-]*)/.exec(args[args.length - 1]!)?.[1];
    if (output) found.push({ component, upstream: args[0]!, output });
  }
  const out: ComponentReads = {};
  for (const f of found) {
    const reader = dirOf.get(f.component) ?? f.component;
    const upstream = dirOf.get(f.upstream) ?? f.upstream;
    if (reader === upstream) continue;
    const names = ((out[reader] ??= {})[upstream] ??= []);
    if (!names.includes(f.output)) names.push(f.output);
  }
  for (const ups of Object.values(out)) for (const names of Object.values(ups)) names.sort();
  return out;
}

/**
 * The `!terraform.output` reads of every stack manifest in an Atmos repo: the
 * `.yaml`/`.yml` files under `stacks.base_path` of `<repo>/atmos.yaml`
 * (`stacks` when it names none), joined. Empty when the repo has no atmos.yaml.
 */
export function atmosStackReads(repo: string): ComponentReads {
  const config = join(repo, "atmos.yaml");
  if (!existsSync(config)) return {};
  let base = "stacks";
  const text = readFileSync(config, "utf8");
  const stacks = /^stacks\s*:\s*$([\s\S]*?)(?=^\S|(?![\s\S]))/m.exec(text);
  const named = stacks ? /^\s+base_path\s*:\s*(["']?)([^"'#\s]+)\1/m.exec(stacks[1]!) : null;
  if (named) base = named[2]!;
  const out: ComponentReads = {};
  const walk = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(e.name)) {
        for (const [reader, ups] of Object.entries(atmosOutputReads(readFileSync(p, "utf8")))) {
          for (const [up, names] of Object.entries(ups)) {
            const into = ((out[reader] ??= {})[up] ??= []);
            for (const n of names) if (!into.includes(n)) into.push(n);
            into.sort();
          }
        }
      }
    }
  };
  walk(join(repo, base));
  return out;
}

/**
 * Module `m`'s reads of the other modules' outputs that the stack wires in
 * (`componentReads`, from Atmos's `!terraform.output`): one per upstream that
 * is a module of this run, planned and composed, as {@link estateReads} writes
 * them. Under choudoufu the reader is planned on the upstream's planned
 * outputs, so `unknown` names the ones read that the plan cannot know.
 */
export function componentOutputReads(plan: Json, m: string, componentReads: ComponentReads, modules: readonly string[], rootOf: (m: string | undefined) => string): ReportRead[] {
  const reads: ReportRead[] = [];
  for (const [upstream, names] of Object.entries(componentReads[m] ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (upstream === m || !modules.includes(upstream)) continue;
    const unknown = [...unknownOutputsOf(plan, upstream)].filter((n) => names.includes(n)).sort();
    reads.push({ upstream: rootOf(upstream), data: upstream, outputs: "planned", ...(unknown.length ? { unknown } : {}), why: `!terraform.output ${upstream}: ${names.join(", ")}`, composed: true });
  }
  return reads;
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

const COUNTED: ReadonlySet<ChangeSetAction> = new Set(["create", "update", "replace", "delete", "forget"]);

interface RawChange {
  replace_paths?: (string | number)[][];
  importing?: string;
}

function rawChanges(plan: Json): Map<string, RawChange> {
  const out = new Map<string, RawChange>();
  for (const r of Array.isArray(plan.resource_changes) ? plan.resource_changes : []) {
    if (!isObject(r)) continue;
    const change = isObject(r.change) ? r.change : {};
    const paths = Array.isArray(change.replace_paths) ? (change.replace_paths.filter(Array.isArray) as (string | number)[][]) : [];
    const importing = isObject(change.importing) ? String(change.importing.id ?? change.importing.identity ?? "") : undefined;
    out.set(`${r.address}\u0000${r.deposed ?? ""}`, { ...(paths.length > 0 ? { replace_paths: paths } : {}), ...(importing !== undefined ? { importing } : {}) });
  }
  return out;
}

export interface TerraformReport {
  report: Json;
  /** The change set whose digest `report.change_set` names: what behold reads beside the report. */
  changeSet: ChangeSetDocument;
  /** The run's directory, relative to the project's own index: `yyyy/mm/<commit>/<stage>`. */
  path: string;
  row: IndexRow;
}

/** Where a run's report lives under its project: `yyyy/mm/<commit>/<stage>`, by the day it finished. */
export function runPath(commit: string, stage: ReportStage, finished: string): string {
  const at = new Date(finished);
  return `${at.getUTCFullYear()}/${String(at.getUTCMonth() + 1).padStart(2, "0")}/${commit}/${stage}`;
}

/** The report for one composed run, and its index row. Pure. */
export function terraformReport(input: TerraformReportInput): TerraformReport {
  const plan = isObject(input.plan) ? input.plan : {};
  const planner: ChangeSetPlanner = plannerForBinary(input.binary);
  const rootDir = (input.rootDir ?? "").replace(/\/+$/, "");
  const rootOf = (m: string | undefined): string => (m === undefined ? input.selfRoot ?? (rootDir || ".") : rootDir ? `${rootDir}/${m}` : m);

  const changes = Array.isArray(plan.resource_changes) ? plan.resource_changes : [];
  const modules = [...new Set(changes.flatMap((r) => (isObject(r) ? [topModule(String(r.module_address ?? r.address ?? ""))] : [])))];
  // Roots in module order, the composed root's own resources (if any) last.
  const keys = [...modules.filter((m): m is string => m !== undefined).sort(), ...(modules.includes(undefined) ? [undefined] : [])];
  if (keys.length === 0) throw new Error("the plan has no resource changes, so there is nothing to report");

  const applied = input.applied !== undefined ? stateResources(input.applied) : undefined;
  if (input.stage === "tf-apply" && !applied) throw new Error("a tf-apply report needs the post-apply plan (applied) for the values the plan left unknown");

  const slices = new Map(keys.map((m) => [m, slicePlan(plan, m)] as const));
  const parts = keys.map((m) => terraformChangeSetPart({ member: rootOf(m), plan: slices.get(m), planner }));
  const doc = composeChangeSet(parts);
  const summary = groupChangeSet(doc);
  const memberGroup = new Map<string, string>();
  if (summary.unit === "member") for (const g of summary.groups) for (const u of g.units) memberGroup.set(u, g.id);

  const prefixOf = new Map(keys.map((m) => [rootOf(m), m === undefined ? "" : `module.${m}.`] as const));
  const moduleOf = new Map(keys.map((m) => [rootOf(m), m === undefined ? "." : `module.${m}`] as const));

  const roots = doc.members.map((member) => {
    const raw = rawChanges(slices.get(keys.find((m) => rootOf(m) === member.member)!)!);
    const counts: Record<string, number> = {};
    const rootChanges: Json[] = [];
    for (const e of doc.entries as ChangeSetEntry[]) {
      if (e.member !== member.member) continue;
      counts[e.action] = (counts[e.action] ?? 0) + 1;
      const r = raw.get(`${e.address}\u0000${e.deposed ?? ""}`);
      if (e.action === "no-op" && r?.importing === undefined) continue;
      const attributes = applied ? resolveUnknowns(e.attributes, applied.get(`${prefixOf.get(member.member)}${e.address}`)) : e.attributes;
      rootChanges.push({
        address: e.address,
        type: e.type,
        action: e.action,
        ...(e.disruption ? { disruption: e.disruption } : {}),
        ...(e.deposed !== undefined ? { deposed: e.deposed } : {}),
        ...(e.module ? { module: e.module } : {}),
        ...(e.index !== undefined ? { index: e.index } : {}),
        attributes,
        ...(r?.replace_paths ? { replace_paths: r.replace_paths } : {}),
        ...(r?.importing !== undefined ? { importing: r.importing } : {}),
        fold: "open",
      });
    }
    const failed = member.status === "failed";
    const group = memberGroup.get(member.member);
    const mod = keys.find((m) => rootOf(m) === member.member);
    const reads = mod !== undefined && input.estates ? estateReads(plan, mod, input.estates, rootOf) : [];
    if (mod !== undefined && input.componentReads) {
      const named = new Set(reads.map((r) => r.upstream));
      const declared = keys.filter((k): k is string => k !== undefined);
      for (const r of componentOutputReads(plan, mod, input.componentReads, declared, rootOf)) if (!named.has(r.upstream)) reads.push(r);
    }
    return {
      path: member.member,
      binary: { name: planner, ...(input.binaryVersion ? { version: input.binaryVersion } : {}) },
      status: member.status,
      ...(member.error ? { error: member.error } : {}),
      plan_digest: member.planDigest,
      counts,
      ...(group ? { group } : {}),
      plan: {},
      ...(reads.length > 0 ? { reads } : {}),
      ...(input.run.job_url ? { job_url: input.run.job_url } : {}),
      changes: rootChanges,
      highlights: [],
      fold: rootChanges.length > 0 || failed ? "open" : "folded",
      why: failed ? ["refused to plan"] : [],
      composed: { wave: 1, module: moduleOf.get(member.member)! },
    };
  });

  const groups = summary.groups.map((g) => ({
    id: g.id,
    ...(g.resource ? { resource: g.resource } : {}),
    units: g.units,
    outlier: g.outlier,
    noChanges: g.noChanges,
    changes: g.changes,
    ...(g.extends ? { extends: g.extends } : {}),
    ...(g.plus ? { plus: g.plus } : {}),
    destroys: g.destroys.length,
    varies: [],
    fold: g.destroys.length > 0 || g.outlier ? "open" : "folded",
    why: [...(g.outlier ? ["outlier: read it on its own"] : []), ...(g.destroys.length > 0 ? [`${g.destroys.length} destroys or replacements`] : [])],
  }));

  const named: { root: string; address?: string; type?: string; action: string; deposed?: string; reason?: string }[] = [
    ...summary.destroys.map((d) => ({ root: d.member, address: d.address, type: d.type, action: d.action, ...(d.deposed ? { deposed: d.deposed } : {}) })),
    ...summary.forgets.map((d) => ({ root: d.member, address: d.address, type: d.type, action: "forget" as const })),
    ...summary.failed.map((f) => ({ root: f.member, action: "refused" as const, reason: f.reason })),
  ];

  const totals = { ...doc.summary.actions } as Record<ChangeSetAction, number>;
  const changing = new Set(doc.entries.filter((e) => COUNTED.has(e.action)).map((e) => e.member));
  const planDigests = doc.members.map((m) => m.planDigest);
  const failedAny = planDigests.some((d) => d === null);
  const stage = input.stage;
  const rootPaths = doc.members.map((m) => m.member);
  const members = doc.members.map((m) => {
    const planned = Object.entries(roots.find((r) => r.path === m.member)!.counts).filter(([a]) => COUNTED.has(a as ChangeSetAction)).reduce((n, [, c]) => n + c, 0);
    return {
      root: m.member,
      module: moduleOf.get(m.member)!,
      ...(stage === "tf-apply" ? { apply: planned === 0 ? "no-changes" : "applied", changes: { done: planned, planned }, state: "written" } : {}),
    };
  });
  const wave = {
    number: 1,
    roots: rootPaths,
    set_digest: failedAny ? null : changeSetDigest(doc.members),
    approval: "not-requested",
    state: failedAny ? "failed" : stage === "tf-apply" ? "applied" : "planned",
    composed: { plan_digest: failedAny ? null : changeSetDigest(doc.members), members },
  };

  const run = {
    project: input.run.project,
    commit: input.run.commit,
    stage,
    binary: planner,
    runtime: input.runtime ?? "ci",
    started: input.started ?? input.finished,
    finished: input.finished,
    ...(input.run.job_url ? { job_url: input.run.job_url } : {}),
    ...(input.run.commit_url ? { commit_url: input.run.commit_url } : {}),
    ...(input.run.pull_request ? { pull_request: input.run.pull_request } : {}),
    ...(input.run.pull_request_url ? { pull_request_url: input.run.pull_request_url } : {}),
  };

  const report: Json = {
    schema: REPORT_SCHEMA,
    minor: REPORT_MINOR,
    run,
    change_set: doc.digest,
    unit: summary.unit,
    units: summary.units,
    totals,
    totals_roots: changing.size,
    groups,
    roots,
    waves: [wave],
    named,
    holes: summary.holes.map((h) => ({ root: h.member, address: h.address, ...(h.type ? { type: h.type } : {}), reason: h.reason })),
    redaction: { marker: REDACTED, values: 0 },
    compose: { roots: rootPaths, max: rootPaths.length, wave: 1, ...(planner === "choudoufu" ? { estate: true as const } : {}) },
  };

  const path = runPath(input.run.commit, stage, input.finished);
  const failed = roots.filter((r) => r.status === "failed").length;
  const row: IndexRow = {
    project: input.run.project,
    commit: input.run.commit,
    stage,
    finished: input.finished,
    path,
    roots: roots.length,
    groups: groups.length,
    totals: { create: totals.create, update: totals.update, replace: totals.replace, delete: totals.delete },
    refused: named.filter((n) => n.action === "refused").length,
    failed,
    changed: roots.filter((r) => r.status === "planned" && r.changes.length > 0).length,
    destroys: named.filter((n) => n.action === "delete" || n.action === "replace").map((n) => `${n.root}: ${n.address}`),
    ...(stage === "tf-apply" && failed === 0 ? { applied: input.finished } : {}),
    ...(run.commit_url ? { commit_url: run.commit_url } : {}),
    ...(run.pull_request ? { pull_request: run.pull_request } : {}),
    ...(run.pull_request_url ? { pull_request_url: run.pull_request_url } : {}),
    ...(run.job_url ? { job_url: run.job_url } : {}),
  };
  return { report, changeSet: doc, path, row };
}

// ---------------------------------------------------------------------------
// The indexes.
// ---------------------------------------------------------------------------

/** How many rows an index keeps. */
export const INDEX_ROWS = 500;

/**
 * `existing` index text with `row` added: a row at the same path is replaced,
 * newest first, an unreadable index starts again from this row.
 */
export function addToIndex(existing: string | undefined, row: IndexRow): { schema: string; reports: IndexRow[] } {
  let reports: IndexRow[] = [];
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as { reports?: unknown };
      if (Array.isArray(parsed.reports)) reports = parsed.reports as IndexRow[];
    } catch {
      // An unreadable index is rebuilt from this run on.
    }
  }
  reports = [...reports.filter((r) => r.path !== row.path), row];
  reports.sort((a, b) => (a.finished < b.finished ? 1 : a.finished > b.finished ? -1 : a.path < b.path ? -1 : 1));
  return { schema: INDEX_SCHEMA, reports: reports.slice(0, INDEX_ROWS) };
}

/** A place the report's files go: a key is `project/...` under the reports prefix. */
export interface ReportStore {
  read(key: string): Promise<string | undefined>;
  put(key: string, body: string): Promise<void>;
}

/**
 * Write the run's `report.json` and `change-set.json` (the document whose
 * digest the report names, as `chant change-set` writes it), and add its row to the project's index
 * (`<project>/index.json`, paths relative to it) and to the prefix's
 * (`index.json`, paths starting at the project), the two places terragucci
 * writes. Returns the keys written.
 */
export async function writeReport(store: ReportStore, r: TerraformReport): Promise<string[]> {
  const project = r.row.project;
  const keys: string[] = [];
  const put = async (key: string, value: unknown): Promise<void> => {
    await store.put(key, JSON.stringify(value, null, 2) + "\n");
    keys.push(key);
  };
  await put(`${project}/${r.path}/report.json`, r.report);
  await put(`${project}/${r.path}/change-set.json`, r.changeSet);
  for (const [key, path] of [[`${project}/index.json`, r.path], ["index.json", `${project}/${r.path}`]] as const) {
    await put(key, addToIndex(await store.read(key), { ...r.row, path }));
  }
  return keys;
}

/** A store under a local directory: what the tests and a job that uploads itself use. */
export function dirStore(dir: string): ReportStore {
  return {
    async read(key) {
      try {
        return readFileSync(join(dir, key), "utf8");
      } catch {
        return undefined;
      }
    },
    async put(key, body) {
      mkdirSync(dirname(join(dir, key)), { recursive: true });
      writeFileSync(join(dir, key), body);
    },
  };
}

/**
 * A store behind an HTTP address that takes unsigned `GET` and `PUT` of
 * `<base>/<key>`: the demo's floci bucket, `http://floci:4566/<bucket>/<prefix>`.
 * It signs nothing, so it does not write to AWS S3 or another store that asks
 * for credentials. A 404 on read is no object.
 */
export function httpStore(base: string, fetcher: typeof fetch = fetch): ReportStore {
  const url = (key: string): string => `${base.replace(/\/+$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
  return {
    async read(key) {
      const res = await fetcher(url(key));
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`GET ${url(key)}: ${res.status}`);
      return res.text();
    },
    async put(key, body) {
      const res = await fetcher(url(key), { method: "PUT", headers: { "content-type": "application/json" }, body });
      if (!res.ok) throw new Error(`PUT ${url(key)}: ${res.status}`);
    },
  };
}
