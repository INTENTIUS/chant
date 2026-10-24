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
 * groups and named destroys, and the index row. After an apply, a second
 * `show -json` (of a plan made once the apply finished, whose `prior_state`
 * holds the state) fills in the values the plan left unknown. It writes no
 * report.html, no plan files, no policy, cost or approval fields.
 *
 * The change set is {@link terraformChangeSetPart}'s, and the grouping is
 * chant's `groupChangeSet`, so a report here and one from terragucci agree on
 * what changed.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { changeSetDigest, composeChangeSet, type ChangeSetAction, type ChangeSetAttribute, type ChangeSetEntry, type ChangeSetPlanner } from "@intentius/chant/change-set";
import { groupChangeSet } from "@intentius/chant/plan-summary";
import { plannerForBinary, terraformChangeSetPart } from "./change-set";

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

const TOP_MODULE = /^module\.([^.[\]]+)(?:\[(?:"(?:[^"\\]|\\.)*"|\d+)\])?(?:\.|$)/;

/** The top-level module an address or module address is in, or undefined for the composed root's own. */
export function topModule(address: string): string | undefined {
  return TOP_MODULE.exec(address)?.[1];
}

/** `address` with its leading `module.<m>` (and index) taken off. */
function unprefix(address: string): string {
  const m = TOP_MODULE.exec(address);
  return m ? address.slice(m[0].length) : address;
}

/** The plan's `resource_changes` that belong to module `m` (undefined: the root's own), each with the module taken off its address. */
export function slicePlan(plan: unknown, m: string | undefined): Json {
  const p = isObject(plan) ? plan : {};
  const list = Array.isArray(p.resource_changes) ? p.resource_changes : [];
  const mine = list.filter((r) => isObject(r) && topModule(String(r.module_address ?? r.address ?? "")) === m);
  const resource_changes = mine.map((r) => {
    const rc = r as Json;
    const out: Json = { ...rc, address: unprefix(String(rc.address)) };
    if (typeof rc.previous_address === "string") out.previous_address = unprefix(rc.previous_address);
    if (typeof rc.module_address === "string") {
      const rest = unprefix(rc.module_address);
      if (rest === "" || rest === rc.module_address) delete out.module_address;
      else out.module_address = rest;
    }
    return out;
  });
  return { ...(p.errored === true ? { errored: true } : {}), resource_changes };
}

// ---------------------------------------------------------------------------
// Applied values: the state after the apply gives the values the plan left unknown.
// ---------------------------------------------------------------------------

/** Whether a sensitivity map marks anything under it `true`. */
function marks(v: unknown): boolean {
  if (v === true) return true;
  if (Array.isArray(v)) return v.some(marks);
  if (isObject(v)) return Object.values(v).some(marks);
  return false;
}

/** Every resource of a `show -json` state, by address. A deposed object is left out. */
function stateResources(show: unknown): Map<string, { values: Json; sensitive: Json }> {
  const out = new Map<string, { values: Json; sensitive: Json }>();
  const walk = (mod: unknown): void => {
    if (!isObject(mod)) return;
    for (const r of Array.isArray(mod.resources) ? mod.resources : []) {
      if (!isObject(r) || typeof r.address !== "string" || r.deposed_key !== undefined) continue;
      out.set(r.address, { values: isObject(r.values) ? r.values : {}, sensitive: isObject(r.sensitive_values) ? r.sensitive_values : {} });
    }
    for (const c of Array.isArray(mod.child_modules) ? mod.child_modules : []) walk(c);
  };
  const root = isObject(show) ? show : {};
  // A plan's `prior_state` is the state; a `show -json` of state has `values` itself.
  const state = isObject(root.prior_state) ? root.prior_state : root;
  const values = isObject(state.values) ? state.values : {};
  walk(values.root_module);
  return out;
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
    return {
      path: member.member,
      binary: { name: planner, ...(input.binaryVersion ? { version: input.binaryVersion } : {}) },
      status: member.status,
      ...(member.error ? { error: member.error } : {}),
      plan_digest: member.planDigest,
      counts,
      ...(group ? { group } : {}),
      plan: {},
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
  return { report, path, row };
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
 * Write the run's `report.json` and add its row to the project's index
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
