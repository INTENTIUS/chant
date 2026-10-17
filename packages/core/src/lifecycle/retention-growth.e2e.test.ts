/**
 * How `chant/lifecycle` grows in a month at chant's own rate, and what
 * retention's garbage collection takes back (#4036, requirement 3).
 *
 * The rates are chant's own, counted from its repository for the thirty days
 * from 2026-09-17 to 2026-10-16:
 *
 *   855 first-parent commits on main     28.5 a day: one recorded run each
 *   751 squash-merged pull requests      25 a day: a pull-request gate each,
 *                                        with a stored change set, a pending
 *                                        fact and an approval
 *   96 chant-v and 44 reference-          4.7 a day: a release cut each, of
 *   workspace-v tags                     two members in the same proportion
 *   0 ci/revoked tags
 *
 * A release changes one or two of its member's three components, so the
 * other templates keep their bytes and are stored once. Each release deploys
 * to staging under a release gate that passes `empty`, and every third one is
 * promoted to prod after an approval. A month of that is written to a temp repository, one commit per
 * write as chant writes them (through `git fast-import`, to be quick), with
 * one local run event file per run. Then the garbage collection runs with
 * the default policy at the end of the month, and the test prints the tree
 * at the tip and the packed history before and after.
 *
 * End to end: it writes a few thousand commits and repacks twice.
 */

import { describe, expect, test } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contentDigest } from "../content-digest";
import { makeRelease } from "./release-store";
import { runLifecycleGc } from "./retention";
import { DEFAULT_RETENTION } from "./retention-policy";
import { RUN_EVENTS_DIR_ENV } from "../run-event-store";

const DAYS = 30;
const RATES = { runs: 855 / 30, pullRequests: 751 / 30, releases: 140 / 30 };
const MEMBERS = [
  { name: "chant", share: 96 / 140, components: ["api", "worker", "web"] },
  { name: "reference-workspace", share: 44 / 140, components: ["svc", "db", "edge"] },
];
const START = Date.UTC(2026, 8, 17);
const DAY = 86_400_000;

/** A small deterministic generator, so every run writes the same month. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(4036);
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rand() * 16).toString(16)).join("");
const iso = (ms: number) => new Date(ms).toISOString();

/** A compiled template of a component: a deployment manifest of about 4 KB. */
function template(component: string, env: string, version: number): string {
  const lines = [`apiVersion: apps/v1`, `kind: Deployment`, `metadata:`, `  name: ${component}`, `  namespace: ${env}`, `  labels:`, `    app.kubernetes.io/managed-by: chant`, `    chant.intentius.io/env: ${env}`, `spec:`, `  replicas: ${env === "prod" ? 3 : 1}`, `  template:`, `    spec:`, `      containers:`, `        - name: ${component}`, `          image: registry.example.com/${component}@${contentDigest(`${component}:${version}`)}`, `          env:`];
  for (let i = 0; i < 40; i++) lines.push(`            - name: SETTING_${i}`, `              value: "${component}-${env}-${i % 7 === 0 ? version : i}"`);
  lines.push(`          resources:`, `            limits: { cpu: "${env === "prod" ? 2 : 1}", memory: 512Mi }`);
  return `${lines.join("\n")}\n`;
}

/** A stored change-set document of a few entries, about 2 to 4 KB. */
function changeSet(digest: string, member: string, entries: number): string {
  const doc = {
    $schema: "https://intentius.io/chant/schemas/change-set/v1/change-set.schema.json",
    contract: 1,
    digest,
    members: [member],
    entries: Array.from({ length: entries }, (_, i) => ({
      member,
      component: `c${i % 3}`,
      address: `aws_lambda_function.handler_${hex(6)}`,
      action: ["update", "create", "delete"][i % 3],
      before: { memory_size: 256, timeout: 30, environment: { LOG_LEVEL: "info", REVISION: hex(12) } },
      after: { memory_size: 512, timeout: 30, environment: { LOG_LEVEL: "info", REVISION: hex(12) } },
      node: `${member}:${hex(16)}`,
    })),
    graph: { digest: `sha256:${hex(64)}`, nodes: 40 },
  };
  return `${JSON.stringify(doc)}\n`;
}

interface Write {
  at: number;
  message: string;
  files: Array<{ path: string; content?: string; append?: string }>;
}

/** The month's writes, oldest first, and the run event files it leaves. */
function month(): { writes: Write[]; runs: Array<{ at: number; id: string; text: string }> } {
  const writes: Write[] = [];
  const runs: Array<{ at: number; id: string; text: string }> = [];
  const spread = (perDay: number, fn: (at: number, i: number) => void) => {
    const total = Math.round(perDay * DAYS);
    for (let i = 0; i < total; i++) fn(START + ((i + rand()) / total) * DAYS * DAY, i);
  };
  const line = (o: object) => `${JSON.stringify(o)}\n`;

  // Runs: a run record on the run ledger and a local event file.
  spread(RATES.runs, (at, i) => {
    const op = `op-${i % 12}`;
    const id = `run-${i}-${hex(8)}`;
    writes.push({ at, message: `Op run record: ${op}`, files: [{ path: `_members/chant/ci/runs__${op}.jsonl`, append: line({ version: 1, op, runId: id, status: "succeeded", startedAt: iso(at - 60_000), finishedAt: iso(at), gitSha: hex(40), actor: "ci", runOrigin: { forge: "github", repo: "INTENTIUS/chant", url: `https://github.com/INTENTIUS/chant/actions/runs/${i}` }, waves: [{ name: "build", status: "succeeded" }, { name: "check", status: "succeeded" }] }) }] });
    const events = Array.from({ length: 40 }, (_, k) => line({ runId: id, name: op, index: k, type: k === 0 ? "run-start" : k === 39 ? "run-settle" : "step-done", at: iso(at - 60_000 + k * 1000), step: `step-${k}`, status: "ok", detail: hex(40) }));
    runs.push({ at, id, text: events.join("") });
  });

  // Pull requests: a change set, a pending fact, and an approval two hours on.
  spread(RATES.pullRequests, (at, i) => {
    const member = i % 5 === 4 ? "reference-workspace" : "chant";
    const prefix = `_members/${member}/`;
    const digest = `jcs1-sha256:${hex(64)}`;
    const op = `pr-${3300 + i}`;
    const gates = `${prefix}_gates/${op}.jsonl`;
    writes.push({ at, message: `Change set ${digest}`, files: [{ path: `${prefix}_change-sets/${digest.replace(/:/g, "_")}.json`, content: changeSet(digest, member, 4 + (i % 9)) }] });
    writes.push({ at: at + 1000, message: "Pending gate record", files: [{ path: gates, append: line({ version: 1, kind: "pending", op, gate: "review", timestamp: iso(at + 1000), expiresAt: iso(at + 1000 + 2 * DAY), planDigest: digest, gitSha: hex(40), runId: `${i}`, url: `https://github.com/INTENTIUS/chant/pull/${3300 + i}` }) }] });
    writes.push({ at: at + 2 * 3600_000, message: "Gate resolution record", files: [{ path: gates, append: line({ version: 1, kind: "resolution", op, gate: "review", resolvedBy: "github:lex00", timestamp: iso(at + 2 * 3600_000), planDigest: digest, gitSha: hex(40) }) }] });
  });

  // Releases: cut, deploy to staging under an empty release gate, every third promoted to prod after an approval.
  const version = new Map<string, number>();
  /** The release version each component's bytes last changed in. */
  const built = new Map<string, number>();
  spread(RATES.releases, (at, i) => {
    const m = rand() < MEMBERS[0].share ? MEMBERS[0] : MEMBERS[1];
    const prefix = `_members/${m.name}/`;
    const v = (version.get(m.name) ?? 0) + 1;
    version.set(m.name, v);
    // One or two components change in a release; the rest keep their template bytes.
    const changed = new Set(m.components.filter((_, k) => k === v % 3 || (v % 2 === 0 && k === (v + 1) % 3)));
    const templates: Array<{ env: string; component: string; content: string }> = [];
    for (const c of m.components) if (changed.has(c) || !built.has(c)) built.set(c, v);
    for (const env of ["staging", "prod"]) for (const c of m.components) templates.push({ env, component: c, content: template(c, env, built.get(c)!) });
    const release = makeRelease({
      member: m.name,
      commit: hex(40),
      artifactDigests: m.components.map((c) => ({ component: c, kind: "image" as const, path: `${c}.tar`, digest: contentDigest(`${c}:${built.get(c)}`) })),
      targets: ["staging", "prod"].map((env) => ({
        env,
        templates: templates.filter((t) => t.env === env).map((t) => ({ component: t.component, path: `dist/${t.component}.yaml`, digest: contentDigest(t.content) })),
        params: [{ name: "replicas", value: env === "prod" ? 3 : 1, source: "default" }],
      })),
    });
    const stem = (d: string) => d.replace(/:/g, "_");
    writes.push({
      at,
      message: `Release ${release.releaseDigest}`,
      files: [{ path: `${prefix}_releases/${stem(release.releaseDigest)}.json`, content: `${JSON.stringify(release)}\n` }, ...templates.map((t) => ({ path: `${prefix}_releases/templates/${stem(contentDigest(t.content))}.txt`, content: t.content }))],
    });
    writes.push({ at: at + 1000, message: "Release cut", files: [{ path: `${prefix}_releases/cuts.jsonl`, append: line({ version: 1, releaseDigest: release.releaseDigest, label: `v0.${100 + i}.0`, actor: "lex00", timestamp: iso(at + 1000), runOrigin: null, signature: null }) }] });
    const promote = (env: string, t: number, approved: boolean) => {
      const cs = `jcs1-sha256:${hex(64)}`;
      writes.push({ at: t, message: `Change set ${cs}`, files: [{ path: `${prefix}_change-sets/${stem(cs)}.json`, content: changeSet(cs, m.name, 3) }] });
      const gate = { op: "release", gate: "ship", planDigest: cs, releaseDigest: release.releaseDigest, environment: env };
      if (approved) {
        writes.push({ at: t + 1000, message: "Pending gate record", files: [{ path: `${prefix}_gates/release.jsonl`, append: line({ version: 1, kind: "pending", ...gate, timestamp: iso(t + 1000), expiresAt: iso(t + 1000 + 2 * DAY) }) }] });
        writes.push({ at: t + 3600_000, message: "Gate resolution record", files: [{ path: `${prefix}_gates/release.jsonl`, append: line({ version: 1, kind: "resolution", ...gate, resolvedBy: "github:lex00", timestamp: iso(t + 3600_000) }) }] });
      } else {
        writes.push({ at: t + 1000, message: "Gate resolution record", files: [{ path: `${prefix}_gates/release.jsonl`, append: line({ version: 1, kind: "resolution", ...gate, resolvedBy: "chant", empty: true, timestamp: iso(t + 1000) }) }] });
      }
      const deployedAt = t + (approved ? 3600_000 : 0) + 5000;
      for (const c of m.components) {
        writes.push({ at: deployedAt, message: "Release record", files: [{ path: `${prefix}${env}/releases.jsonl`, append: line({ version: 1, component: c, env, digest: release.artifactDigests.find((a) => a.component === c)!.digest, gitSha: release.commit, runId: hex(10), timestamp: iso(deployedAt), actor: "ci", releaseDigest: release.releaseDigest, runOrigin: { forge: "github", repo: "INTENTIUS/chant" } }) }] });
      }
    };
    promote("staging", at + 60_000, false);
    if (i % 3 === 0) promote("prod", at + 6 * 3600_000, true);
  });

  writes.sort((a, b) => a.at - b.at);
  return { writes, runs };
}

/** Write every commit with `git fast-import`, as chant/lifecycle's history would hold them. */
function importMonth(dir: string, writes: readonly Write[]): void {
  const state = new Map<string, string>();
  const chunks: string[] = [];
  writes.forEach((w, i) => {
    const seconds = Math.floor(w.at / 1000);
    chunks.push(`commit refs/heads/chant/lifecycle\nmark :${i + 1}\ncommitter chant <chant@localhost> ${seconds} +0000\ndata ${Buffer.byteLength(w.message)}\n${w.message}\n`);
    if (i > 0) chunks.push(`from :${i}\n`);
    for (const f of w.files) {
      const content = f.content ?? `${state.get(f.path) ?? ""}${f.append}`;
      state.set(f.path, content);
      chunks.push(`M 100644 inline ${f.path}\ndata ${Buffer.byteLength(content)}\n${content}\n`);
    }
  });
  execFileSync("git", ["fast-import", "--quiet"], { cwd: dir, input: chunks.join(""), maxBuffer: 1024 * 1024 * 1024 });
}

/** The packed size of the repository, which holds chant/lifecycle alone. */
function packed(dir: string): { commits: number; objects: number; packKiB: number } {
  execFileSync("git", ["repack", "-a", "-d", "-q"], { cwd: dir });
  const v = Object.fromEntries(
    execFileSync("git", ["count-objects", "-v"], { cwd: dir, encoding: "utf-8" })
      .trim()
      .split("\n")
      .map((l) => l.split(": ")),
  ) as Record<string, string>;
  const commits = Number(execFileSync("git", ["rev-list", "--count", "chant/lifecycle"], { cwd: dir, encoding: "utf-8" }).trim());
  return { commits, objects: Number(v["in-pack"]), packKiB: Number(v["size-pack"]) };
}

const kib = (bytes: number) => Math.round(bytes / 1024);

describe("retention at chant's own rate (#4036)", () => {
  test("a month of records, then gc with the default policy", async () => {
    await withTestDir(async (dir) => {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
      const events = join(dir, ".run-events");
      mkdirSync(events);
      const prior = process.env[RUN_EVENTS_DIR_ENV];
      process.env[RUN_EVENTS_DIR_ENV] = events;
      try {
        const { writes, runs } = month();
        importMonth(dir, writes);
        for (const r of runs) {
          const file = join(events, `${r.id}.jsonl`);
          writeFileSync(file, r.text);
          utimesSync(file, r.at / 1000, r.at / 1000);
        }
        const eventBytes = () => readdirSync(events).reduce((n, f) => n + statSync(join(events, f)).size, 0);
        const eventsBefore = { files: readdirSync(events).length, kib: kib(eventBytes()) };
        const historyBefore = packed(dir);

        const now = new Date(START + DAYS * DAY);
        const t0 = Date.now();
        const report = await runLifecycleGc({ cwd: dir, policy: DEFAULT_RETENTION, now, dryRun: false });
        const gcMs = Date.now() - t0;
        const historyAfter = packed(dir);
        const eventsAfter = { files: readdirSync(events).length, kib: kib(eventBytes()) };

        const lc = report.lifecycle;
        const tree = (s: typeof lc.before) => ({
          files: s.files,
          kib: kib(s.bytes),
          changeSets: `${s.changeSets.files} files, ${kib(s.changeSets.bytes)} KiB`,
          releases: `${s.releases.files} files, ${kib(s.releases.bytes)} KiB`,
          templates: `${s.templates.files} files, ${kib(s.templates.bytes)} KiB`,
          ledgers: `${s.ledgers.files} files, ${kib(s.ledgers.bytes)} KiB`,
        });
        const summary = {
          rates: { runsPerDay: RATES.runs, pullRequestGatesPerDay: RATES.pullRequests, releasesPerDay: RATES.releases, days: DAYS, writes: writes.length },
          policy: DEFAULT_RETENTION,
          removed: { changeSets: lc.remove.filter((f) => f.kind === "change-set").length, releases: lc.remove.filter((f) => f.kind === "release").length, templates: lc.remove.filter((f) => f.kind === "template").length },
          treeBefore: tree(lc.before),
          treeAfter: tree(lc.after),
          historyBefore,
          historyAfter,
          runEventsBefore: eventsBefore,
          runEventsAfter: eventsAfter,
          gcMs,
        };
        console.log(`retention fixture (#4036):\n${JSON.stringify(summary, null, 2)}`);

        expect(lc.commit).not.toBeNull();
        expect(lc.after.bytes).toBeLessThan(lc.before.bytes);
        expect(lc.after.ledgers).toEqual(lc.before.ledgers);
        // The prune adds a commit and its trees; it never takes history back.
        expect(historyAfter.commits).toBe(historyBefore.commits + 1);
        expect(historyAfter.packKiB).toBeGreaterThanOrEqual(historyBefore.packKiB);
        expect(eventsAfter.files).toBeLessThan(eventsBefore.files);
        // What prod and staging run, and the newest releases, stay.
        expect(lc.keep.some((f) => f.reasons.some((r) => r.code === "deployed"))).toBe(true);
      } finally {
        if (prior === undefined) delete process.env[RUN_EVENTS_DIR_ENV];
        else process.env[RUN_EVENTS_DIR_ENV] = prior;
      }
    });
  }, 300_000);
});
