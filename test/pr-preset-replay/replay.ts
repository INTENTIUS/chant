/**
 * The pull request preset replay (#5118). Runs this checkout's chant over the
 * saved corpus of merged changes, on the parent and on the commit of each,
 * keeps the findings that are new in the change by identity, labels them from
 * `corpus.json`, and prints the precision of the preset's merge-blocking
 * findings. Exits 1 when the preset misses the bar in `score.ts`, or when a
 * merge-blocking finding has no label yet.
 *
 *   npx tsx test/pr-preset-replay/replay.ts --corpus <dir> [--work <dir>] [--jobs <n>] [--record <file>]
 *
 * The corpus directory holds `corpus.bundle` (a git bundle with one tag
 * `c/<commit>` per parent and commit, holding the replayed directories),
 * `changes.json` (the changes in scope and the files each touched) and
 * `charts/` (the Helm charts the localize check renders, and the index from
 * values file to chart). `--work` keeps the clone, the reports and the
 * per-file projects between runs; a fresh directory reruns everything.
 * `--record <file>` writes the findings of this run, with the labels
 * `corpus.json` has for them, so a new finding can be labelled by hand.
 * `--labels <file>` scores against another labelled file, for a corpus of
 * another window of history.
 *
 * Three checks run, as the replay that measured 2.0% did:
 *
 * - `chant audit <tree> --format json` over the whole tree. A finding counts
 *   when it is in a touched unit: a changed file, or a Terraform root that is
 *   a changed directory or calls one through a local module.
 * - Per changed Kubernetes manifest, Grafana dashboard and Prometheus rule
 *   file: `chant import`, then `chant lint --format json` on the import.
 * - Per changed Helm values file with a saved chart: `chant helm localize`.
 *   A render that was stable on the parent and is not on the commit is a
 *   finding.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAll } from "js-yaml";
import { findingIdentities } from "../../packages/core/src/audit/identity";
import { PULL_REQUEST_PRESET, resolveRulePreset } from "../../packages/core/src/audit/pull-request-preset";
import type { Severity } from "../../packages/core/src/lint/rule";
import {
  barFailures,
  findingKey,
  gateOf,
  LOCALIZE_CHECK_ID,
  pct,
  reasonOf,
  score,
  type Corpus,
  type LabelledFinding,
  type ReplayFinding,
} from "./score";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const CORPUS_JSON = join(HERE, "corpus.json");

interface Change {
  sha: string;
  parent: string;
  date: string;
  classes: string[];
  /** [status, path, class] */
  files: Array<[string, string, string]>;
}

interface Args {
  corpus: string;
  work: string;
  jobs: number;
  chant: string;
  record?: string;
  preset: string;
  /** Replay only these changes (commit prefixes), for a quick look. */
  only?: string[];
  /** The labelled findings to score against; `corpus.json` here by default. */
  labels: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const corpus = get("--corpus") ?? process.env.CHANT_REPLAY_CORPUS;
  if (!corpus) throw new Error("--corpus <dir> (or CHANT_REPLAY_CORPUS) names the saved corpus");
  return {
    corpus: resolve(corpus),
    work: resolve(get("--work") ?? process.env.CHANT_REPLAY_WORK ?? join(tmpdir(), "chant-pr-preset-replay")),
    jobs: Number(get("--jobs") ?? 4),
    chant: resolve(get("--chant") ?? join(REPO, "packages/core/bin/chant")),
    record: get("--record"),
    preset: get("--preset") ?? PULL_REQUEST_PRESET.name,
    only: get("--only")?.split(","),
    labels: resolve(get("--labels") ?? CORPUS_JSON),
  };
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts: { cwd?: string; input?: Buffer | string; timeoutMs?: number } = {}): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (b) => out.push(b));
    child.stderr.on("data", (b) => err.push(b));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 600_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout: Buffer.concat(out).toString("utf-8"), stderr: Buffer.concat(err).toString("utf-8") });
    });
    // A child that exits before reading its input closes the pipe; that is not an error here.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.input ?? "");
  });
}

async function pool<T>(items: readonly T[], jobs: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
}

class Corpusrepo {
  constructor(readonly gitDir: string) {}
  async git(...args: string[]): Promise<string> {
    const r = await run("git", ["--git-dir", this.gitDir, ...args]);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  }
  /** The blob at `path` in commit `sha`, or undefined when the path is absent. */
  async blob(sha: string, path: string): Promise<string | undefined> {
    const r = await run("git", ["--git-dir", this.gitDir, "rev-parse", "--verify", "--quiet", `c/${sha}:${path}`]);
    return r.code === 0 ? r.stdout.trim() : undefined;
  }
  async show(blob: string): Promise<string> {
    return this.git("cat-file", "blob", blob);
  }
}

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

// ---------------------------------------------------------------- audit

interface AuditReport {
  snapshot: { files: string[] };
  findings: Array<{ checkId: string; severity: Severity; message: string; file: string; entity?: string; identity: string }>;
}

async function auditCommit(a: Args, repo: Corpusrepo, sha: string): Promise<void> {
  const out = join(a.work, "audit", `${sha}.json`);
  if (existsSync(out)) return;
  const tree = mkdtempSync(join(tmpdir(), "replay-tree-"));
  try {
    const tar = await new Promise<number | null>((done) => {
      const archive = spawn("git", ["--git-dir", repo.gitDir, "archive", `c/${sha}`], { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } });
      const untar = spawn("tar", ["-x", "-C", tree]);
      untar.stdin.on("error", () => {});
      archive.stdout.pipe(untar.stdin);
      untar.on("close", done);
    });
    if (tar !== 0) throw new Error(`could not extract ${sha}`);
    const started = Date.now();
    const r = await run(a.chant, ["audit", tree, "--format", "json", "--tier", "all", "--fail-on", "none", "--max-files", "100000", "-o", `${out}.tmp`], { cwd: tree });
    if (!existsSync(`${out}.tmp`)) throw new Error(`chant audit failed on ${sha}: ${r.stderr.slice(-800)}`);
    writeFileSync(`${out}.log`, `exit=${r.code} secs=${((Date.now() - started) / 1000).toFixed(1)}\n${r.stderr}`);
    renameSync(`${out}.tmp`, out);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

/** Local module directories each Terraform directory calls, followed transitively. */
async function localModuleCalls(repo: Corpusrepo, sha: string): Promise<Map<string, Set<string>>> {
  const r = await run("git", ["--git-dir", repo.gitDir, "grep", "-n", "-E", `^[[:space:]]*source[[:space:]]*=[[:space:]]*"\\.\\.?/`, `c/${sha}`, "--", "infra/*.tf"]);
  const calls = new Map<string, Set<string>>();
  for (const line of r.stdout.split("\n")) {
    if (!line) continue;
    const [, path, , rest] = splitGrep(line);
    const m = /"(\.\.?\/[^"]*)"/.exec(rest);
    if (!m) continue;
    const dir = posix.dirname(path);
    const target = posix.normalize(posix.join(dir, m[1].split("//")[0]));
    let set = calls.get(dir);
    if (!set) calls.set(dir, (set = new Set()));
    set.add(target);
  }
  const closure = new Map<string, Set<string>>();
  for (const dir of calls.keys()) {
    const seen = new Set<string>();
    const visit = (d: string) => {
      for (const t of calls.get(d) ?? []) {
        if (!seen.has(t)) {
          seen.add(t);
          visit(t);
        }
      }
    };
    visit(dir);
    closure.set(dir, seen);
  }
  return closure;
}

/** `git grep` prints `<rev>:<path>:<line>:<text>`; the text may hold colons. */
function splitGrep(line: string): [string, string, string, string] {
  const a = line.indexOf(":");
  const b = line.indexOf(":", a + 1);
  const c = line.indexOf(":", b + 1);
  return [line.slice(0, a), line.slice(a + 1, b), line.slice(b + 1, c), line.slice(c + 1)];
}

async function auditFindings(a: Args, repo: Corpusrepo, change: Change): Promise<ReplayFinding[]> {
  const base = JSON.parse(readFileSync(join(a.work, "audit", `${change.parent}.json`), "utf-8")) as AuditReport;
  const head = JSON.parse(readFileSync(join(a.work, "audit", `${change.sha}.json`), "utf-8")) as AuditReport;
  const changed = change.files.map(([, path]) => path);
  const tfDirs = new Set(change.files.filter(([, , c]) => c === "terraform").map(([, path]) => posix.dirname(path)));
  const units = new Set([...base.snapshot.files, ...head.snapshot.files]);
  const touched = new Set(changed);
  for (const sha of [change.parent, change.sha]) {
    const calls = await localModuleCalls(repo, sha);
    for (const d of tfDirs) {
      if (units.has(d)) touched.add(d);
      for (const [root, mods] of calls) if (mods.has(d) && units.has(root)) touched.add(root);
    }
  }
  const before = new Set(base.findings.map((f) => f.identity));
  return head.findings
    .filter((f) => touched.has(f.file) && !before.has(f.identity))
    .map((f) => ({
      change: change.sha,
      check: "audit" as const,
      rule: f.checkId,
      file: f.file,
      identity: f.identity,
      severity: f.severity,
      ...(f.entity ? { entity: f.entity } : {}),
      message: f.message,
    }));
}

// ---------------------------------------------------------------- per-file lint

type FileKind = "k8s" | "grafana" | "prom";

const FILE_KIND: Record<string, FileKind> = { "k8s-yaml": "k8s", grafana: "grafana", prometheus: "prom" };
const LEXICONS: Record<FileKind, string[]> = { k8s: ["k8s", "prometheus", "grafana"], grafana: ["grafana"], prom: ["prometheus"] };
const EXT: Record<FileKind, string> = { k8s: "yaml", grafana: "json", prom: "yaml" };

interface LintDiag {
  file: string;
  ruleId: string;
  severity: Severity;
  message: string;
  entity?: string;
  locator?: string;
}

/** A YAML file is linted when one of its documents is a Kubernetes object other than a kustomization. */
function isManifest(text: string): boolean {
  let docs: unknown[];
  try {
    docs = loadAll(text);
  } catch {
    return false;
  }
  return docs.some((d) => {
    if (typeof d !== "object" || d === null) return false;
    const o = d as Record<string, unknown>;
    if (!("apiVersion" in o) || !("kind" in o)) return false;
    return !(o.kind === "Kustomization" && String(o.apiVersion).includes("kustomize.config"));
  });
}

async function lintFile(a: Args, repo: Corpusrepo, kind: FileKind, blob: string): Promise<void> {
  const dir = join(a.work, "file", `${kind}-${blob}`);
  if (existsSync(join(dir, "done"))) return;
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, "node_modules"))) symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  writeFileSync(join(dir, "package.json"), `{"name":"replay","private":true,"type":"module"}\n`);
  writeFileSync(join(dir, "chant.config.ts"), `export default { lexicons: ${JSON.stringify(LEXICONS[kind])} };\n`);
  const original = `original.${EXT[kind]}`;
  writeFileSync(join(dir, original), await repo.show(blob));
  const imp = await run(a.chant, ["import", original, "--output", "src"], { cwd: dir, timeoutMs: 300_000 });
  writeFileSync(join(dir, "import.log"), `exit=${imp.code}\n${imp.stdout}\n${imp.stderr}`);
  const lint = await run(a.chant, ["lint", "src", "--format", "json"], { cwd: dir, timeoutMs: 300_000 });
  writeFileSync(join(dir, "lint.json"), lint.stdout);
  writeFileSync(join(dir, "lint.err"), `exit=${lint.code}\n${lint.stderr}`);
  writeFileSync(join(dir, "done"), "");
}

function lintDiagnostics(a: Args, kind: FileKind, blob: string): LintDiag[] {
  const dir = join(a.work, "file", `${kind}-${blob}`);
  const text = readFileSync(join(dir, "lint.json"), "utf-8").trim();
  if (!text) return [];
  try {
    const diags = JSON.parse(text) as LintDiag[];
    // Identity reads the path inside the import project, so both sides agree.
    return diags.map((d) => ({ ...d, file: relative(dir, d.file) }));
  } catch {
    return [];
  }
}

function lintIdentities(diags: LintDiag[]): string[] {
  return findingIdentities(diags.map((d) => ({ checkId: d.ruleId, file: d.file, entity: d.entity, locator: d.locator })));
}

interface FileUnit {
  path: string;
  kind: FileKind;
  before?: string;
  after?: string;
}

async function fileUnits(repo: Corpusrepo, change: Change): Promise<FileUnit[]> {
  const units: FileUnit[] = [];
  for (const [, path, cls] of change.files) {
    const kind = FILE_KIND[cls];
    if (!kind) continue;
    const before = await repo.blob(change.parent, path);
    const after = await repo.blob(change.sha, path);
    if (kind === "k8s") {
      const sides = await Promise.all([before, after].filter((b): b is string => !!b).map(async (b) => isManifest(await repo.show(b))));
      if (!sides.some(Boolean)) continue;
    }
    units.push({ path, kind, before, after });
  }
  return units;
}

function lintFindings(a: Args, change: Change, units: FileUnit[]): ReplayFinding[] {
  const out: ReplayFinding[] = [];
  for (const u of units) {
    if (!u.after) continue;
    const before = u.before ? lintDiagnostics(a, u.kind, u.before) : [];
    const after = lintDiagnostics(a, u.kind, u.after);
    const had = new Set(lintIdentities(before));
    const ids = lintIdentities(after);
    after.forEach((d, i) => {
      if (had.has(ids[i])) return;
      out.push({
        change: change.sha,
        check: "lint",
        rule: d.ruleId,
        file: u.path,
        identity: ids[i],
        severity: d.severity,
        ...(d.entity ? { entity: d.entity } : {}),
        message: d.message,
      });
    });
  }
  return out;
}

// ---------------------------------------------------------------- helm localize

/** Values type to the chart directory under `charts/`, as the corpus saved them. */
const CHARTS: Record<string, string> = {
  KubePrometheusStackValues: "kps/kube-prometheus-stack",
  MimirDistributedValues: "mimir/mimir-distributed",
  DatadogValues: "datadog/datadog",
  ExternalSecretsValues: "es/external-secrets",
  FastlyExporterValues: "fastly/prometheus-fastly-exporter",
  IstiodValues: "istiod/istiod",
  KyvernoValues: "kyverno/kyverno",
};

const localizeCache = new Map<string, Promise<string>>();

async function localizeStatus(a: Args, repo: Corpusrepo, chart: string, blob: string): Promise<string> {
  const key = `${chart} ${blob}`;
  let p = localizeCache.get(key);
  if (!p) {
    p = (async () => {
      const dir = join(a.work, "localize");
      mkdirSync(dir, { recursive: true });
      const out = join(dir, `${blob}-${chart.replace(/\W/g, "_")}.txt`);
      if (existsSync(out)) return readFileSync(out, "utf-8");
      const values = join(dir, `${blob}.yaml`);
      writeFileSync(values, await repo.show(blob));
      const project = join(a.work, "localize-project");
      mkdirSync(project, { recursive: true });
      if (!existsSync(join(project, "node_modules"))) symlinkSync(join(REPO, "node_modules"), join(project, "node_modules"));
      writeFileSync(join(project, "package.json"), `{"name":"replay-helm","private":true,"type":"module"}\n`);
      writeFileSync(join(project, "chant.config.ts"), `export default { lexicons: ["k8s", "helm"] };\n`);
      const r = await run(a.chant, ["helm", "localize", join(a.corpus, "charts", chart), "--values", values], { cwd: project });
      const text = `${r.stdout}${r.stderr}`.trim();
      writeFileSync(out, text);
      return text;
    })();
    localizeCache.set(key, p);
  }
  return p;
}

async function localizeFindings(a: Args, repo: Corpusrepo, change: Change, index: Map<string, string>): Promise<ReplayFinding[]> {
  const out: ReplayFinding[] = [];
  for (const [, path] of change.files) {
    const type = index.get(path);
    const chart = type ? CHARTS[type] : undefined;
    if (!chart) continue;
    const before = await repo.blob(change.parent, path);
    const after = await repo.blob(change.sha, path);
    if (!after) continue;
    const b = before ? await localizeStatus(a, repo, chart, before) : "absent";
    const h = await localizeStatus(a, repo, chart, after);
    if (h.startsWith("unstable") && !b.startsWith("unstable")) {
      const detail = h.split("\n").filter((l) => /pin:|suppliable/.test(l)).map((l) => l.trim()).slice(0, 6);
      out.push({
        change: change.sha,
        check: "localize",
        rule: LOCALIZE_CHECK_ID,
        file: path,
        identity: findingIdentities([{ checkId: LOCALIZE_CHECK_ID, file: path }])[0],
        severity: "warning",
        message: [h.split("\n")[0], ...detail].join(" | ").slice(0, 600),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- main

export async function replay(a: Args): Promise<{ findings: ReplayFinding[]; changes: string[] }> {
  const changes = (JSON.parse(readFileSync(join(a.corpus, "changes.json"), "utf-8")) as { changes: Change[] }).changes.filter(
    (c) => !a.only || a.only.some((p) => c.sha.startsWith(p)),
  );
  mkdirSync(join(a.work, "audit"), { recursive: true });
  mkdirSync(join(a.work, "file"), { recursive: true });
  const gitDir = join(a.work, "corpus.git");
  if (!existsSync(gitDir)) {
    const r = await run("git", ["clone", "--quiet", "--bare", join(a.corpus, "corpus.bundle"), gitDir]);
    if (r.code !== 0) throw new Error(`could not clone the corpus bundle: ${r.stderr}`);
    await run("git", ["--git-dir", gitDir, "fetch", "--quiet", join(a.corpus, "corpus.bundle"), "refs/tags/*:refs/tags/*"]);
  }
  const repo = new Corpusrepo(gitDir);

  const commits = [...new Set(changes.flatMap((c) => [c.parent, c.sha]))];
  let done = 0;
  log(`auditing ${commits.length} commits`);
  await pool(commits, a.jobs, async (sha) => {
    await auditCommit(a, repo, sha);
    if (++done % 25 === 0) log(`  audited ${done} of ${commits.length}`);
  });

  const unitsByChange = new Map<string, FileUnit[]>();
  for (const c of changes) unitsByChange.set(c.sha, await fileUnits(repo, c));
  const jobs = new Map<string, [FileKind, string]>();
  for (const units of unitsByChange.values()) {
    for (const u of units) for (const b of [u.before, u.after]) if (b) jobs.set(`${u.kind}-${b}`, [u.kind, b]);
  }
  done = 0;
  log(`linting ${jobs.size} file versions`);
  await pool([...jobs.values()], a.jobs, async ([kind, blob]) => {
    await lintFile(a, repo, kind, blob);
    if (++done % 50 === 0) log(`  linted ${done} of ${jobs.size}`);
  });

  const index = new Map<string, string>(
    (JSON.parse(readFileSync(join(a.corpus, "charts", "values-index.json"), "utf-8")) as Array<[string, string, string]>).map(([path, type]) => [path, type]),
  );
  const findings: ReplayFinding[] = [];
  for (const c of changes) {
    findings.push(...(await auditFindings(a, repo, c)));
    findings.push(...lintFindings(a, c, unitsByChange.get(c.sha) ?? []));
    findings.push(...(await localizeFindings(a, repo, c, index)));
  }
  return { findings, changes: changes.map((c) => c.sha) };
}

function loadCorpus(path: string): Corpus {
  return JSON.parse(readFileSync(path, "utf-8")) as Corpus;
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  const preset = resolveRulePreset(a.preset);
  if (!preset) throw new Error(`unknown preset ${a.preset}`);
  const { findings, changes } = await replay(a);
  const corpus: Corpus = existsSync(a.labels) ? loadCorpus(a.labels) : { meta: {}, reasons: {}, changes: [], findings: [] };
  const labels = new Map(corpus.findings.map((f) => [findingKey(f), f]));

  const labelled: LabelledFinding[] = [];
  const unlabelled: ReplayFinding[] = [];
  for (const f of findings) {
    const l = labels.get(findingKey(f));
    if (l) labelled.push({ ...f, label: l.label, reason: l.reason });
    else unlabelled.push(f);
  }

  if (a.record) {
    const recorded: Corpus = {
      meta: { ...corpus.meta, recordedAt: new Date().toISOString(), changes: changes.length },
      reasons: corpus.reasons,
      changes,
      findings: [...labelled, ...unlabelled.map((f) => ({ ...f, label: "noise" as const, reason: "UNLABELLED" }))],
    };
    writeFileSync(a.record, `${JSON.stringify(recorded, null, 1)}\n`);
    log(`wrote ${recorded.findings.length} findings to ${a.record}`);
  }

  const all = score(labelled);
  const gated = score(labelled, preset);
  const blockingUnlabelled = unlabelled.filter((f) => gateOf(preset, f) === "merge-blocking");
  const expectedTrue = corpus.findings.filter((f) => f.label === "true");
  const seen = new Set(findings.map(findingKey));
  const lost = expectedTrue.filter((f) => !seen.has(findingKey(f)));

  const lines: string[] = [];
  lines.push(`Replayed ${changes.length} changes: ${findings.length} new findings, ${unlabelled.length} without a label.`);
  lines.push(`Every rule on: ${all.truePositives} of ${all.findings} true, precision ${pct(all.precision)}.`);
  lines.push(
    `Preset ${preset.name}, merge-blocking: ${gated.truePositives} of ${gated.findings} true, precision ${gated.findings === 0 ? "n/a" : pct(gated.precision)}, on ${gated.blockedChanges.length} of ${changes.length} changes.`,
  );
  lines.push("", "Merge-blocking findings:");
  for (const f of labelled.filter((x) => gateOf(preset, x) === "merge-blocking")) {
    lines.push(`  ${f.change.slice(0, 10)} ${f.check} ${f.rule} ${f.file}  ${f.label.toUpperCase()}: ${reasonOf(corpus, f)}`);
  }
  for (const f of blockingUnlabelled) lines.push(`  ${f.change.slice(0, 10)} ${f.check} ${f.rule} ${f.file}  NO LABEL: ${f.message.slice(0, 160)}`);
  lines.push("", "By rule, merge-blocking:");
  for (const [rule, r] of Object.entries(gated.byRule).sort()) lines.push(`  ${rule}: ${r.total} (${r.true} true, ${r.debatable} debatable, ${r.noise} noise)`);
  console.log(lines.join("\n"));

  const failures = barFailures(gated);
  if (blockingUnlabelled.length > 0) failures.push(`${blockingUnlabelled.length} merge-blocking finding(s) have no label in corpus.json`);
  if (lost.length > 0) failures.push(`${lost.length} true finding(s) in corpus.json were not found again: ${lost.map((f) => `${f.rule} ${f.file}`).join("; ")}`);
  for (const f of failures) console.error(`FAIL: ${f}`);
  if (failures.length === 0) console.log(`\nThe preset meets the bar.`);
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    },
  );
}
