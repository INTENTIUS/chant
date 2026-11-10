/**
 * Scheduled watch and reconcile Ops that stopped running (#4289).
 *
 * A schedule can stop with no error anywhere. GitHub turns a scheduled
 * workflow off after 60 days with no activity in the repository and drops
 * scheduled runs under load. A GitLab schedule exists only once someone
 * creates it. A watch Op cannot report its own absence, so the pull-request
 * plan job does. For each discovered Op with a `schedule` and the `Watch` or
 * `Reconcile` label, whose generated pipeline file is in the checkout, it
 * asks the forge when the Op's job last ran. When the cron has fired at
 * least twice since then, or since the pipeline file was added for a job
 * that never ran, the job log and the plan note say the Op is overdue.
 *
 * One late or dropped run is not enough: two fires are. A forge that will
 * not answer is a line in the log and no verdict.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { OpConfig } from "./types";
import { cronFiresUtc } from "./cron";
import type { ForgeKind, PrForge, ScheduledRuns, ScheduledRunsQuery } from "../pr-forge";
import { parseYAMLDocument, splitYAMLDocuments } from "../yaml";

/** One scheduled watch or reconcile Op the plan job checks. */
export interface ScheduledWatch {
  op: string;
  cron: string;
  /**
   * The files a product's generator wrote for the job, relative to the
   * repository root (#4789). The first one in the checkout is the Op's
   * pipeline file. Left out, {@link opPipelineFile} looks for the file
   * `chant run --generate` writes, then reads every workflow or pipeline
   * file it finds.
   */
  files?: readonly string[];
  /**
   * GitLab: the schedule selector of the job's `rules: if:` when it is not
   * `CHANT_SCHEDULED_OP` set to `op` (#4789), as `scheduledRuns` takes it
   * (#4813). The check finds the file by it, asks the forge with it, and a
   * missing schedule's line names it.
   */
  schedule?: ScheduledRunsQuery["schedule"];
  /**
   * The product plan's targets whose note checks this watch (#4988), such
   * as the environment a drift watch reads. Left out, every target's note
   * does. A note of another target checks neither the watch nor a
   * discovered Op of the same name.
   */
  targets?: readonly string[];
}

/**
 * The watches the note of `target` checks (#4988): the ones with no
 * `targets`, and the ones naming it. Without a target, every one.
 */
export function watchesForTarget(watches: readonly ScheduledWatch[], target: string | undefined): ScheduledWatch[] {
  if (target === undefined) return [...watches];
  return watches.filter((w) => w.targets === undefined || w.targets.includes(target));
}

/** An Op the plan note warns about. */
export interface OverdueOp {
  op: string;
  cron: string;
  /** The time the count starts from: the job's last run, or the pipeline file's first commit (ISO 8601). */
  since: string;
  /** True when no run is on record and `since` is the pipeline file's first commit. */
  neverRan?: boolean;
  /** The line for the job log and the plan note. */
  message: string;
}

/**
 * The discovered Ops that are scheduled watch or reconcile Ops: a
 * `schedule`, and the `Watch` label `WatchOp` sets (./composites/watch-op.ts)
 * or the `Reconcile` label `ReconcileOp` sets (./composites/reconcile-op.ts).
 * Sorted by name.
 */
export function scheduledWatches(ops: Iterable<OpConfig>): ScheduledWatch[] {
  const out: ScheduledWatch[] = [];
  for (const op of ops) {
    if (!op.schedule?.cron) continue;
    if (op.labels?.Watch !== "true" && op.labels?.Reconcile !== "true") continue;
    out.push({ op: op.name, cron: op.schedule.cron });
  }
  return out.sort((a, b) => a.op.localeCompare(b.op));
}

/**
 * The pipeline file an Op's scheduled job is in, relative to the repository
 * root, or undefined when the checkout has none, so an Op that some other
 * scheduler runs is never checked.
 *
 * With `files` (a product's own generator, #4789), the first of them in the
 * checkout. Otherwise, on GitHub and Forgejo, the file `chant run --generate
 * <forge>` writes, `<dir>/<op>.yml` (`<member>-<op>.yml` in a workspace
 * member, or `.yaml`), and failing that the first workflow in `<dir>` whose
 * `name:` is the Op's. On GitLab a scheduled job can be in any pipeline
 * file, so each one {@link gitlabPipelineFiles} finds is read for the one
 * whose rules select the Op (#4789).
 */
export function opPipelineFile(repoRoot: string, forge: ForgeKind, watch: string | Pick<ScheduledWatch, "op" | "files" | "schedule">, member?: string): string | undefined {
  const w = typeof watch === "string" ? { op: watch } : watch;
  if (w.files) return w.files.find((f) => existsSync(join(repoRoot, f)));
  const base = member ? `${member}-${w.op}` : w.op;
  if (forge === "github" || forge === "forgejo") {
    const dir = `.${forge}/workflows`;
    const exact = [`${dir}/${base}.yml`, `${dir}/${base}.yaml`].find((p) => existsSync(join(repoRoot, p)));
    if (exact) return exact;
    return listDir(join(repoRoot, dir))
      .filter((n) => /\.ya?ml$/.test(n))
      .sort()
      .map((n) => `${dir}/${n}`)
      .find((p) => {
        const name = yamlDocs(repoRoot, p)[0]?.name;
        return name === base || name === w.op;
      });
  }
  const selects = gitlabSelector(w);
  return gitlabPipelineFiles(repoRoot).find((p) => {
    try {
      return selects(readFileSync(join(repoRoot, p), "utf8"));
    } catch {
      return false;
    }
  });
}

/**
 * Whether a GitLab file's text holds the job's schedule rule. The gitlab
 * lexicon's cron rule tests `$CHANT_SCHEDULED_OP == "<op>"`. A `schedule`
 * selector's rule tests its variable against its value, or against each of
 * its `not` values with `!=`.
 */
function gitlabSelector(w: Pick<ScheduledWatch, "op" | "schedule">): (text: string) => boolean {
  const s = w.schedule ?? { variable: "CHANT_SCHEDULED_OP", value: w.op };
  const needles = s.value !== undefined ? [`$${s.variable} == "${s.value}"`] : s.not?.length ? s.not.map((n) => `$${s.variable} != "${n}"`) : [`$${s.variable}`];
  return (text) => needles.every((n) => text.includes(n));
}

/** Directories the walk for pipeline files never enters. */
const SKIP_DIRS = new Set([".git", "node_modules", ".chant", "dist"]);

/**
 * Every GitLab pipeline file in the checkout, relative to the root, in the
 * order {@link opPipelineFile} reads them (#4789): the root's
 * `*.gitlab-ci.yml`, then the local files `.gitlab-ci.yml` includes and
 * the child pipelines they trigger (`trigger: include:`), then every file
 * under `.gitlab/` and every `*.gitlab-ci.yml` further down. An include
 * with a wildcard or a variable is not followed; the walk finds its files
 * when they are under `.gitlab/` or named `*.gitlab-ci.yml`.
 */
export function gitlabPipelineFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    if (!out.includes(p) && existsSync(join(repoRoot, p))) out.push(p);
  };
  for (const n of listDir(repoRoot).filter((n) => n.endsWith(".gitlab-ci.yml")).sort()) add(n);
  const queue = existsSync(join(repoRoot, ".gitlab-ci.yml")) ? [".gitlab-ci.yml"] : [];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const doc of yamlDocs(repoRoot, file)) {
      for (const inc of localIncludes(doc)) {
        add(inc);
        queue.push(inc);
      }
    }
  }
  const walk = (dir: string, depth: number, underGitlab: boolean) => {
    if (depth > 8) return;
    for (const n of listDir(join(repoRoot, dir)).sort()) {
      const rel = dir ? `${dir}/${n}` : n;
      let isDir: boolean;
      try {
        isDir = statSync(join(repoRoot, rel)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (!SKIP_DIRS.has(n)) walk(rel, depth + 1, underGitlab || rel === ".gitlab");
      } else if (dir !== "" && (n.endsWith(".gitlab-ci.yml") || (underGitlab && /\.ya?ml$/.test(n)))) add(rel);
    }
  };
  walk("", 0, false);
  return out;
}

/** The local files a GitLab document includes, with each job's `trigger: include:`, as paths from the root. */
function localIncludes(doc: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const read = (inc: unknown) => {
    for (const entry of Array.isArray(inc) ? inc : [inc]) {
      // A string include is local unless it is a URL; a mapping is local only with `local:`.
      const path = typeof entry === "string" ? (/^https?:\/\//.test(entry) ? undefined : entry) : isRecord(entry) && typeof entry.local === "string" ? entry.local : undefined;
      if (path && !path.includes("*") && !path.includes("$")) paths.push(path.replace(/^\/+/, ""));
    }
  };
  read(doc.include);
  for (const job of Object.values(doc)) {
    if (isRecord(job) && isRecord(job.trigger)) read(job.trigger.include);
  }
  return paths;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** A YAML file's mapping documents, or none when it cannot be read or parsed. */
function yamlDocs(repoRoot: string, path: string): Record<string, unknown>[] {
  try {
    return splitYAMLDocuments(readFileSync(join(repoRoot, path), "utf8"))
      .map((d) => parseYAMLDocument(d))
      .filter(isRecord);
  } catch {
    return [];
  }
}

/** When `path` was first committed (ISO 8601), if the checkout's history has it. */
export function fileAdded(repoRoot: string, path: string): string | undefined {
  return addedCommit(repoRoot, path)?.at;
}

/** The oldest commit the checkout's history says added `path`, with its commit time. */
function addedCommit(repoRoot: string, path: string): { sha: string; at: string } | undefined {
  const r = spawnSync("git", ["-C", repoRoot, "log", "--format=%H %cI", "--diff-filter=A", "--", path], { encoding: "utf-8" });
  if (r.status !== 0) return undefined;
  const last = r.stdout.trim().split("\n").filter(Boolean).pop();
  if (!last) return undefined;
  const [sha, at] = last.split(" ");
  return sha && at ? { sha, at } : undefined;
}

/**
 * The commits a shallow checkout's history stops at (#4952), from git's
 * `shallow` file. Empty for a full clone.
 */
function shallowBoundary(repoRoot: string): Set<string> {
  const r = spawnSync("git", ["-C", repoRoot, "rev-parse", "--path-format=absolute", "--git-path", "shallow"], { encoding: "utf-8" });
  if (r.status !== 0) return new Set();
  try {
    return new Set(readFileSync(r.stdout.trim(), "utf-8").split("\n").map((l) => l.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** How long the check waits for the fetch that deepens a shallow checkout. */
const DEEPEN_TIMEOUT_MS = 120_000;

/**
 * When `path` was added, read so a shallow checkout does not under-report
 * (#4952). A CI checkout is often shallow, and its oldest commit lists
 * every file as added, so a job that never ran would count from that
 * commit. When the commit found is at the shallow boundary, the check
 * fetches the rest of the history once per run (`git fetch --unshallow`,
 * with the job's own credentials) and reads the file again. When that fetch
 * fails, the boundary's time is still a lower bound, so the check counts
 * from it and says so in the log.
 */
function addedDate(repoRoot: string, path: string, op: string, state: { deepened?: boolean; failed?: string }, log: (line: string) => void): string | undefined {
  let found = addedCommit(repoRoot, path);
  if (!found || !shallowBoundary(repoRoot).has(found.sha)) return found?.at;
  if (!state.deepened) {
    state.deepened = true;
    const r = spawnSync("git", ["-C", repoRoot, "fetch", "--quiet", "--unshallow"], { encoding: "utf-8", timeout: DEEPEN_TIMEOUT_MS });
    if (r.status !== 0) state.failed = (r.stderr || r.error?.message || `git fetch exited ${r.status}`).trim().split("\n")[0];
    // A checkout with no remote answers 0 and stays shallow.
    else if (shallowBoundary(repoRoot).size > 0) state.failed = "git fetch --unshallow left it shallow";
    found = addedCommit(repoRoot, path) ?? found;
  }
  if (state.failed !== undefined && shallowBoundary(repoRoot).has(found.sha)) {
    log(`schedule check: the checkout is shallow and its history could not be fetched, so Op ${op} counts from its oldest commit, ${found.at.slice(0, 10)}: ${state.failed}`);
  }
  return found.at;
}

const HINT: Record<ForgeKind, string> = {
  github: "GitHub turns a scheduled workflow off after 60 days with no activity in the repository. Turn the workflow on again under Actions, or run it by hand",
  gitlab: "A GitLab project runs a scheduled Op only from a pipeline schedule. Check its schedule under CI/CD > Schedules",
  forgejo: "Check that Actions is on for the repository and a runner is up, or run the workflow by hand",
};

/** GitLab: what no active schedule does, in the words of the job's selector (#4789). */
function noScheduleLine(watch: ScheduledWatch): string {
  const s = watch.schedule;
  if (!s) return `No active pipeline schedule sets CHANT_SCHEDULED_OP to ${watch.op}`;
  if (s.value !== undefined) return `No active pipeline schedule sets ${s.variable} to ${s.value}`;
  if (s.not?.length) return `No active pipeline schedule is picked by the Op's rule, one whose ${s.variable} is none of ${s.not.join(", ")}`;
  return `No active pipeline schedule sets ${s.variable}`;
}

/**
 * Whether one Op is overdue: its cron has fired at least twice since its
 * last run, or since `added` when no run is on record. Undefined when it is
 * on time, or when nothing says when it should have run.
 */
export function overdueVerdict(watch: ScheduledWatch, forge: ForgeKind, runs: ScheduledRuns, added: string | undefined, now: Date): OverdueOp | undefined {
  const since = runs.last ?? added;
  if (!since) return undefined;
  if (cronFiresUtc(watch.cron, new Date(since), now, 2).length < 2) return undefined;
  const day = since.slice(0, 10);
  const what = runs.last ? `its last run was on ${day}` : `no run is on record since its pipeline was added on ${day}`;
  const why = runs.disabled
    ? `GitHub has turned the workflow off (${runs.disabled}). Turn it on again under Actions`
    : forge === "gitlab" && runs.noSchedule
      ? `${noScheduleLine(watch)}. Add one with the cron \`${watch.cron}\` under CI/CD > Schedules`
      : HINT[forge];
  return {
    op: watch.op,
    cron: watch.cron,
    since,
    ...(runs.last ? {} : { neverRan: true }),
    message: `Op \`${watch.op}\` is overdue: its schedule \`${watch.cron}\` has fired at least twice and ${what}. ${why}.`,
  };
}

/**
 * The plan job's check over every scheduled watch or reconcile Op that has a
 * generated pipeline file. Each Op the forge will not answer for is a line
 * in `log` and no verdict. A forge client with no `scheduledRuns` checks
 * nothing. A product with its own generator passes each job's `files` and,
 * on GitLab, its `schedule` selector, and needs no lookup of its own
 * (#4789); `forge` is any client with `kind` and `scheduledRuns`.
 */
export async function checkOverdueOps(input: {
  watches: readonly ScheduledWatch[];
  forge: Pick<PrForge, "kind" | "scheduledRuns">;
  repoRoot: string;
  member?: string;
  now: Date;
  log: (line: string) => void;
} & OverdueWords): Promise<OverdueOp[]> {
  const { forge } = input;
  if (!forge.scheduledRuns) return [];
  const log = (line: string): void => input.log(`${input.logPrefix ?? ""}${line}`);
  const out: OverdueOp[] = [];
  // One fetch at most per check, however many Ops count from a shallow boundary (#4952).
  const history: { deepened?: boolean; failed?: string } = {};
  for (const watch of input.watches) {
    const file = opPipelineFile(input.repoRoot, forge.kind, watch, input.member);
    if (!file) continue;
    let runs: ScheduledRuns;
    try {
      runs = await forge.scheduledRuns({ op: watch.op, workflow: file.split("/").pop()!, ...(watch.schedule ? { schedule: watch.schedule } : {}) });
    } catch (err) {
      log(`schedule check: ${forge.kind} did not say when Op ${watch.op} last ran, so it is not checked: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`);
      continue;
    }
    const found = overdueVerdict(watch, forge.kind, runs, runs.last ? undefined : addedDate(input.repoRoot, file, watch.op, history, log), input.now);
    if (found) {
      log(found.message);
      out.push(input.label ? { ...found, message: `${input.label}${found.message}` } : found);
    }
  }
  return out;
}

/**
 * A product's words for the overdue check (#4888), so it passes them in
 * place of wrapping `log` and each verdict's message itself.
 */
export interface OverdueWords {
  /** Put before every line the check writes to `log`, such as `yodel plan: `. */
  logPrefix?: string;
  /** Put before each verdict's `message`, the line the note shows, such as `Warning: `. The log line keeps chant's words. */
  label?: string;
}

/**
 * The variable the generated plan-note job names a product's own scheduled
 * watches in (#4888): a JSON array of {@link ScheduledWatch}, from the
 * pipeline (`productPlan.watches`), never from the plan job's report.
 * `pr-post` checks them with the job's token beside the Ops it discovers.
 */
export const PLAN_WATCHES_ENV = "CHANT_PLAN_WATCHES";

const OP_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const REL_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]+$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A product plan target's name, as ../components/product-plan.ts takes it. */
const WATCH_TARGET = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Why `watch` is not a scheduled watch a pipeline may name (#4888), or
 * undefined when it is: an Op name, a cron of five fields, `files` as
 * relative paths with no `..`, and a GitLab selector of a variable name and
 * plain values. None of them holds a `$`, so GitLab, which expands
 * variables in a job's variables, passes the JSON as written.
 */
export function scheduledWatchProblem(watch: unknown): string | undefined {
  if (!isRecord(watch)) return "a watch is an object with op and cron";
  if (typeof watch.op !== "string" || !OP_NAME.test(watch.op)) return `the watch's op ${JSON.stringify(watch.op)} is not an Op name`;
  if (typeof watch.cron !== "string" || !/^[0-9A-Za-z*\/,? -]+$/.test(watch.cron) || watch.cron.trim().split(/\s+/).length !== 5) return `watch ${watch.op}'s cron ${JSON.stringify(watch.cron)} is not five fields`;
  if (watch.files !== undefined && (!Array.isArray(watch.files) || watch.files.some((f) => typeof f !== "string" || !REL_PATH.test(f)))) return `watch ${watch.op}'s files are not paths from the repository root`;
  if (watch.schedule !== undefined) {
    const s = watch.schedule;
    const plain = (v: unknown): boolean => typeof v === "string" && /^[A-Za-z0-9_.:\/-]+$/.test(v);
    if (!isRecord(s) || typeof s.variable !== "string" || !VAR_NAME.test(s.variable)) return `watch ${watch.op}'s schedule names no variable`;
    if (s.value !== undefined && !plain(s.value)) return `watch ${watch.op}'s schedule value is not a plain word`;
    if (s.not !== undefined && (!Array.isArray(s.not) || !s.not.every(plain))) return `watch ${watch.op}'s schedule not is not a list of plain words`;
  }
  // #4988: the targets whose note checks the watch, by name.
  if (watch.targets !== undefined && (!Array.isArray(watch.targets) || watch.targets.length === 0 || watch.targets.some((t) => typeof t !== "string" || !WATCH_TARGET.test(t)))) return `watch ${watch.op}'s targets are not a list of target names`;
  return undefined;
}

/**
 * The watches {@link PLAN_WATCHES_ENV} names (#4888), each checked with
 * {@link scheduledWatchProblem}; one that is not a watch is a line in `log`
 * and left out. None when the variable is unset or not a JSON array.
 */
export function plannedWatchesFromEnv(env: Record<string, string | undefined> = process.env, log: (line: string) => void = () => undefined): ScheduledWatch[] {
  const raw = env[PLAN_WATCHES_ENV];
  if (!raw?.trim()) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    log(`${PLAN_WATCHES_ENV} is not JSON, so no product watch is checked`);
    return [];
  }
  if (!Array.isArray(doc)) {
    log(`${PLAN_WATCHES_ENV} is not a JSON array, so no product watch is checked`);
    return [];
  }
  const out: ScheduledWatch[] = [];
  for (const w of doc) {
    const problem = scheduledWatchProblem(w);
    if (problem) log(`${PLAN_WATCHES_ENV}: ${problem}, so it is not checked`);
    else out.push(w as ScheduledWatch);
  }
  return out;
}

/**
 * The overdue check over the Ops declared at `cwd` (#4289), as the plan note
 * reports it: the Ops `discoverOps` finds there, and the repository root
 * `cwd` is in. `pr-post` runs it in its own checkout, the target branch's
 * commit, and `chant ci run plan` in a checkout of `--base` (#4328), so the
 * Ops are never read from the change's code. Without a forge that can say
 * when a job ran, nothing is checked. A failure is a line in `log` and no
 * verdict, and the plan goes on.
 */
export async function overdueOpsAt(
  input: {
    forge: PrForge | undefined;
    cwd: string;
    member?: string;
    now?: Date;
    log: (line: string) => void;
    /**
     * A product's own scheduled watches (#4888), checked beside the
     * discovered Ops; one of the same name takes the discovered Op's place.
     * They are checked even when discovery fails. #4988: with `member`, the
     * product plan's target, a watch whose `targets` leave it out is not
     * checked, and neither is the discovered Op of its name.
     */
    watches?: readonly ScheduledWatch[];
  } & OverdueWords,
): Promise<OverdueOp[]> {
  const { forge } = input;
  if (!forge?.scheduledRuns) return [];
  const all = input.watches ?? [];
  const own = watchesForTarget(all, input.member);
  const elsewhere = all.filter((w) => !own.includes(w));
  let discovered: ScheduledWatch[] = [];
  try {
    const { discoverOps } = await import("./discover");
    const found = await discoverOps({ cwd: input.cwd });
    discovered = scheduledWatches([...found.ops.values()].map((d) => d.config));
  } catch (err) {
    input.log(`${input.logPrefix ?? ""}could not check the scheduled Ops, so none is reported overdue: ${err instanceof Error ? err.message : String(err)}`);
    if (own.length === 0) return [];
  }
  const watches = [...discovered.filter((d) => !own.some((w) => w.op === d.op) && !elsewhere.some((w) => w.op === d.op)), ...own];
  if (watches.length === 0) return [];
  try {
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: input.cwd, encoding: "utf-8" });
    if (top.status !== 0) return [];
    return await checkOverdueOps({
      watches,
      forge,
      repoRoot: top.stdout.trim(),
      ...(input.member ? { member: input.member } : {}),
      now: input.now ?? new Date(),
      log: input.log,
      ...(input.logPrefix ? { logPrefix: input.logPrefix } : {}),
      ...(input.label ? { label: input.label } : {}),
    });
  } catch (err) {
    input.log(`${input.logPrefix ?? ""}could not check the scheduled Ops, so none is reported overdue: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
