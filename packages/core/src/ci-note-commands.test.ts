/**
 * Comment commands on GitLab by polling merge request notes (#4785), against
 * a GitLab API on loopback: who may ask, the ledger and the reply marker that
 * keep a note from being answered twice, the pipeline a command starts with
 * its variables, and the apply job an apply on a merged merge request retries.
 * Ported from terragucci's comment-gitlab.test.ts.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTestDir } from "@intentius/chant-test-utils";
import { resolveProductWords } from "./ci-product-words";
import { gitlabForge } from "./pr-forge";
import { gitlabReads } from "./pr-forge-reads";
import {
  APPLY_JOBS,
  chantNoteRuns,
  gitlabPipelines,
  ledgerNoteLog,
  memoryNoteLog,
  noteCommandMarker,
  pollNoteCommands,
  type ChantNoteJobs,
  type NoteCommandRuns,
} from "./ci-note-commands";

const NOW = new Date("2026-10-07T12:00:00Z");
const BOT = 900;
const MERGE = "a".repeat(40);
const LATER = "b".repeat(40);
const HEAD = "c".repeat(40);
const recent = (minutes: number): string => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const WORDS = resolveProductWords({ product: "plywood", commands: { preview: "plan", up: "apply", lock: "lock", unlock: "unlock", agent: "agent", fmt: "commit", action: "action" }, verbs: { plan: ["preview", "previewed"], apply: ["update", "updated"] }, noun: ["stack", "stacks"] });

interface Call { method: string; path: string; body?: any }
interface World {
  mrs: any[];
  notes: Record<number, any[]>;
  /** Access levels by user id. */
  members?: Record<number, number>;
  pipelines?: any[];
  jobs?: Record<number, any[]>;
  statuses?: Record<string, any[]>;
  fail?: RegExp;
}

let server: Server;
let base = "";
let world: World;
let calls: Call[] = [];

/** A user's id is its name's length plus 100, so a note needs only a username. */
const uid = (name: string): number => 100 + name.length;
const user = (name: string) => ({ id: uid(name), username: name });

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url!, "http://x");
      const path = url.pathname.replace(/^\/api\/v4/, "");
      const method = req.method!;
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method, path: `${path}${url.search}`, body });
      const send = (b: unknown, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(b));
      };
      if (world.fail?.test(`${method} ${path}`)) return send({ message: "boom" }, 500);
      const q = url.searchParams;
      // Lists are one page here.
      if (Number(q.get("page") ?? "1") > 1) return send([]);
      let m: RegExpExecArray | null;
      if (path === "/user") return send({ id: BOT, username: "plywood-bot" });
      if (path === "/users") {
        const name = q.get("username")!;
        return send(Object.values(world.notes).flat().some((n) => n.author?.username === name) ? [user(name)] : []);
      }
      if (path === "/projects/7/merge_requests") return send(world.mrs);
      if ((m = /^\/projects\/7\/members\/all\/(\d+)$/.exec(path))) {
        const level = world.members?.[Number(m[1])];
        return level === undefined ? send({ message: "404 Not found" }, 404) : send({ access_level: level });
      }
      if ((m = /^\/projects\/7\/merge_requests\/(\d+)\/notes\/(\d+)$/.exec(path)) && method === "PUT") {
        const n = (world.notes[Number(m[1])] ?? []).find((x) => x.id === Number(m![2]));
        if (n) n.body = body.body;
        return send(n ?? {});
      }
      if ((m = /^\/projects\/7\/merge_requests\/(\d+)\/notes$/.exec(path))) {
        const iid = Number(m[1]);
        if (method === "POST") {
          const note = { id: 5000 + calls.length, body: body.body, system: false, author: { id: BOT, username: "plywood-bot" }, created_at: NOW.toISOString() };
          (world.notes[iid] ??= []).push(note);
          return send(note, 201);
        }
        return send(world.notes[iid] ?? []);
      }
      if ((m = /^\/projects\/7\/merge_requests\/(\d+)\/pipelines$/.exec(path)) && method === "POST") return send({ id: 77, web_url: "http://gitlab/acme/infra/-/pipelines/77" }, 201);
      if (path === "/projects/7/pipeline" && method === "POST") return send({ id: 78, web_url: "http://gitlab/acme/infra/-/pipelines/78" }, 201);
      if (path === "/projects/7/pipelines") {
        const all = (world.pipelines ?? []).filter((p) => (!q.get("sha") || p.sha === q.get("sha")) && (!q.get("ref") || p.ref === q.get("ref")) && (!q.get("source") || p.source === q.get("source")));
        return send([...all].sort((a, b) => b.id - a.id));
      }
      if ((m = /^\/projects\/7\/pipelines\/(\d+)\/jobs$/.exec(path))) return send(world.jobs?.[Number(m[1])] ?? []);
      if ((m = /^\/projects\/7\/repository\/commits\/([0-9a-f]+)\/statuses$/.exec(path))) return send(world.statuses?.[m[1]!] ?? []);
      if ((m = /^\/projects\/7\/jobs\/(\d+)\/retry$/.exec(path)) && method === "POST") return send({ id: 9000 + Number(m[1]), web_url: `http://gitlab/acme/infra/-/jobs/${9000 + Number(m[1])}` }, 201);
      send({ message: "404 Not found" }, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v4`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

beforeEach(() => {
  calls = [];
});

const mr = (iid: number, over: Record<string, unknown> = {}) => ({ iid, state: "opened", sha: HEAD, source_branch: `feat-${iid}`, target_branch: "main", source_project_id: 7, target_project_id: 7, updated_at: recent(5), ...over });
const note = (id: number, body: string, by = "alice", over: Record<string, unknown> = {}) => ({ id, body, system: false, author: user(by), created_at: recent(10), ...over });

async function poll(w: World, o: { jobs?: ChantNoteJobs; runs?: NoteCommandRuns; log?: ReturnType<typeof memoryNoteLog>; minRole?: "developer" | "maintainer" } = {}) {
  world = w;
  const opts = { apiBase: base, project: "7", token: "t", host: "gitlab" };
  const log = o.log ?? memoryNoteLog();
  const got = await pollNoteCommands({
    reads: gitlabReads(opts),
    forge: gitlabForge(opts),
    pipelines: gitlabPipelines(opts),
    words: WORDS,
    base: "main",
    runs: o.runs ?? chantNoteRuns(o.jobs ?? {}),
    log,
    now: NOW,
    ...(o.minRole ? { minRole: o.minRole } : {}),
  });
  return { ...got, log };
}

const posts = (what: RegExp) => calls.filter((c) => c.method === "POST" && what.test(c.path));
const replies = (w: World, iid: number) => (w.notes[iid] ?? []).filter((n) => n.author?.id === BOT).map((n) => n.body as string);

describe("pollNoteCommands: plan", () => {
  test("a Developer's plan on an open merge request starts its pipeline, and the reply carries the note's marker", async () => {
    const w: World = { mrs: [mr(3)], notes: { 3: [note(41, "/plywood preview")] }, members: { [uid("alice")]: 30 } };
    const got = await poll(w);
    expect(posts(/\/merge_requests\/3\/pipelines$/)).toHaveLength(1);
    expect(got.outcomes).toMatchObject([{ mr: 3, note: 41, command: "plan", ran: true, replied: true, url: "http://gitlab/acme/infra/-/pipelines/77" }]);
    expect(replies(w, 3)).toEqual([`plywood: started pipeline http://gitlab/acme/infra/-/pipelines/77 to preview !3 again for alice\n\n${noteCommandMarker("plywood", 41)}`]);
    expect(got.log.outcomes.map((r) => [r.mr, r.note])).toEqual([[3, 41]]);
  });

  test("with the comment preview, a pipeline of the default branch starts with CHANT_PREVIEW_PR and the comment", async () => {
    await poll({ mrs: [mr(3)], notes: { 3: [note(41, "/plywood preview --target aws_s3_bucket.b")] }, members: { [uid("alice")]: 30 } }, { jobs: { preview: true } });
    expect(posts(/\/pipeline$/).map((c) => c.body)).toEqual([
      { ref: "main", variables: [{ key: "CHANT_PREVIEW_PR", value: "3", variable_type: "env_var" }, { key: "CHANT_PREVIEW_COMMENT", value: "/plywood preview --target aws_s3_bucket.b", variable_type: "env_var" }] },
    ]);
  });

  test("answers a note once: the ledger keeps it, and without the ledger the reply's marker does", async () => {
    const w: World = { mrs: [mr(3)], notes: { 3: [note(41, "/plywood preview")] }, members: { [uid("alice")]: 30 } };
    const log = memoryNoteLog();
    await poll(w, { log });
    calls = [];
    expect((await poll(w, { log })).outcomes).toEqual([]);
    expect(posts(/pipelines?$/)).toEqual([]);
    // A fresh ledger still finds the job's reply.
    expect((await poll(w)).outcomes).toEqual([]);
    expect(posts(/pipelines?$/)).toEqual([]);
  });

  test("counts only the job's own marker: one a person wrote answers nothing", async () => {
    const w: World = { mrs: [mr(3)], notes: { 3: [note(41, "/plywood preview"), note(42, noteCommandMarker("plywood", 41), "mallory")] }, members: { [uid("alice")]: 30 } };
    expect((await poll(w)).outcomes.map((o) => [o.note, o.ran])).toEqual([[41, true]]);
  });

  test("a Reporter, or someone who is not a member, gets no reply and nothing runs, and the note is recorded", async () => {
    const w: World = { mrs: [mr(3)], notes: { 3: [note(41, "/plywood preview", "rita"), note(42, "/plywood preview", "nobody")] }, members: { [uid("rita")]: 20 } };
    const got = await poll(w);
    expect(got.outcomes.map((o) => [o.note, o.ran, o.replied, o.reason])).toEqual([
      [41, false, false, "rita is reporter on the project, below developer, so the note is ignored"],
      [42, false, false, "nobody is not a member of the project, so the note is ignored"],
    ]);
    expect(replies(w, 3)).toEqual([]);
    expect(got.log.outcomes).toHaveLength(2);
    expect(posts(/pipelines?$/)).toEqual([]);
  });

  test("minRole raises the bar", async () => {
    const w: World = { mrs: [mr(3)], notes: { 3: [note(41, "/plywood preview")] }, members: { [uid("alice")]: 30 } };
    expect((await poll(w, { minRole: "maintainer" })).outcomes[0]).toMatchObject({ ran: false, replied: false });
  });

  test("refuses a fork's merge request and a closed one", async () => {
    const w: World = { mrs: [mr(3, { source_project_id: 99 }), mr(4, { state: "closed" })], notes: { 3: [note(41, "/plywood preview")], 4: [note(51, "/plywood preview")] }, members: { [uid("alice")]: 30 } };
    const got = await poll(w);
    expect(got.outcomes.map((o) => [o.mr, o.ran, o.reason])).toEqual([
      [3, false, "a merge request from a fork runs no command: its code never runs with this project's credentials"],
      [4, false, "!4 is not open, so it is not previewed"],
    ]);
    expect(posts(/pipelines?$/)).toEqual([]);
  });

  test("leaves notes alone that are not commands, system notes, the job's own, and notes older than the window", async () => {
    const w: World = {
      mrs: [mr(3)],
      notes: { 3: [note(41, "looks good"), note(42, "/plywood preview", "alice", { system: true }), note(43, "/plywood preview", "alice", { created_at: recent(25 * 60) }), note(44, "/plywood preview", "plywood-bot", { author: { id: BOT, username: "plywood-bot" } })] },
      members: { [uid("alice")]: 30 },
    };
    expect((await poll(w)).outcomes).toEqual([]);
  });

  test("answers refused commands with the reason, and commands with no job as unsupported", async () => {
    const w: World = {
      mrs: [mr(3)],
      notes: { 3: [note(41, "/plywood destroy"), note(42, "/plywood lock"), note(43, "/plywood agent fix it"), note(44, "/plywood fmt"), note(45, "/plywood action apps/a rotate")] },
      members: { [uid("alice")]: 30 },
    };
    const got = await poll(w);
    expect(got.outcomes.map((o) => [o.note, o.ran, o.replied])).toEqual([41, 42, 43, 44, 45].map((n) => [n, false, true]));
    expect(got.outcomes.map((o) => o.reason)).toEqual([
      "a comment never runs `destroy`: plywood re-plans, and runs what an approval covers, on request and nothing more",
      "`/plywood lock` does not run here: this project takes no locks",
      "the agent command is off in this project",
      "`/plywood fmt` does not run here",
      "`/plywood action` does not run from a merge request note on GitLab: run `plywood action apps/a rotate` from a checkout of the default branch",
    ]);
    expect(posts(/pipelines?$/)).toEqual([]);
  });

  test("fails the poll when GitLab will not list the merge requests, and a member check that breaks fails the note, which is read again", async () => {
    expect((await poll({ mrs: [], notes: {}, fail: /GET \/projects\/7\/merge_requests$/ })).fail).toMatch(/^could not list the merge requests/);
    const got = await poll({ mrs: [mr(3)], notes: { 3: [note(41, "/plywood preview")] }, fail: /members/ });
    expect(got.outcomes[0]).toMatchObject({ ran: false, replied: false, fail: true });
    expect(got.log.outcomes).toEqual([]);
  });
});

describe("pollNoteCommands: the jobs a command starts", () => {
  const members = { [uid("alice")]: 30 };
  const started = () => posts(/\/pipeline$/).map((c) => Object.fromEntries((c.body.variables as { key: string; value: string }[]).map((v) => [v.key, v.value])));

  test("an apply before merge, a lock, an unlock, the agent and a commit job each start a pipeline of the default branch with their variables", async () => {
    const w: World = {
      mrs: [mr(3)],
      notes: { 3: [note(41, "/plywood up"), note(42, "/plywood lock"), note(43, "/plywood unlock"), note(44, "/plywood agent fix the bucket"), note(45, "/plywood fmt")] },
      members,
    };
    const got = await poll(w, { jobs: { applyBeforeMerge: true, locks: true, agent: true, commits: true } });
    expect(got.outcomes.every((o) => o.ran && o.replied)).toBe(true);
    expect(started()).toEqual([{ CHANT_APPLY_PR: "3" }, { CHANT_LOCK_PR: "3" }, { CHANT_UNLOCK_PR: "3" }, { CHANT_AGENT_PR: "3", CHANT_AGENT_ASK: "fix the bucket" }, { CHANT_COMMIT_PR: "3", CHANT_COMMIT: "fmt" }]);
    expect(posts(/\/pipeline$/).every((c) => c.body.ref === "main")).toBe(true);
    expect(got.outcomes[0]!.reason).toBe(`started pipeline http://gitlab/acme/infra/-/pipelines/78 on main to update !3's head ${HEAD.slice(0, 8)} for alice`);
  });

  test("a product's own runs: its variables, and its refusal", async () => {
    const runs: NoteCommandRuns = ({ mr: m, note: n, parsed }) =>
      parsed.kind === "apply" ? { kind: "pipeline", ref: "main", variables: { TERRAGUCCI_MR: String(m.number), TERRAGUCCI_NOTE: String(n.id), TERRAGUCCI_HEAD: m.headSha! }, doing: "apply it" } : { kind: "reply", text: "no" };
    const w: World = { mrs: [mr(3)], notes: { 3: [note(41, "/plywood up"), note(42, "/plywood preview")] }, members };
    const got = await poll(w, { runs });
    expect(started()).toEqual([{ TERRAGUCCI_MR: "3", TERRAGUCCI_NOTE: "41", TERRAGUCCI_HEAD: HEAD }]);
    expect(got.outcomes.map((o) => o.reason)).toEqual(["started pipeline http://gitlab/acme/infra/-/pipelines/78 on main to apply it for alice", "no"]);
  });

  test("a pipeline GitLab will not start fails the note, which is read again", async () => {
    const got = await poll({ mrs: [mr(3)], notes: { 3: [note(41, "/plywood lock")] }, members, fail: /POST \/projects\/7\/pipeline$/ }, { jobs: { locks: true } });
    expect(got.outcomes[0]).toMatchObject({ ran: false, replied: false, fail: true });
    expect(got.outcomes[0]!.reason).toMatch(/^could not start a pipeline on main for !3/);
    expect(got.log.outcomes).toEqual([]);
  });
});

describe("pollNoteCommands: apply on a merged merge request", () => {
  const members = { [uid("alice")]: 30, [uid("rita")]: 20 };
  const merged = (over: Record<string, unknown> = {}) => mr(3, { state: "merged", merge_commit_sha: MERGE, ...over });
  const jobs = { applyOnMerge: true };
  const pipelines = [{ id: 10, sha: MERGE, ref: "main", source: "push", status: "failed" }];
  const applyJobs = { 10: [{ id: 1, name: "plan", status: "success" }, { id: 2, name: "apply-wave-1", status: "success" }, { id: 4, name: "apply-wave-2-share-2", status: "failed" }, { id: 3, name: "apply-wave-2", status: "failed" }] };

  test("retries the first apply job of the merge commit's pipeline that did not succeed", async () => {
    const got = await poll({ mrs: [merged()], notes: { 3: [note(41, "/plywood up")] }, members, pipelines, jobs: applyJobs }, { jobs });
    expect(posts(/\/jobs\/\d+\/retry$/).map((c) => c.path)).toEqual(["/projects/7/jobs/3/retry"]);
    expect(got.outcomes[0]).toMatchObject({ ran: true, replied: true, url: "http://gitlab/acme/infra/-/jobs/9003" });
    expect(got.outcomes[0]!.reason).toBe(`retried apply-wave-2 of !3's merge commit ${MERGE.slice(0, 8)} (http://gitlab/acme/infra/-/jobs/9003) for alice; its gate decides again, and the jobs after it follow, each behind its own gate`);
  });

  test("takes the squash commit, or the head of a fast-forward merge, when there is no merge commit", async () => {
    await poll({ mrs: [merged({ merge_commit_sha: null, squash_commit_sha: LATER })], notes: { 3: [note(41, "/plywood up")] }, members, pipelines: [{ id: 11, sha: LATER, ref: "main", source: "push" }], jobs: { 11: applyJobs[10] } }, { jobs });
    expect(posts(/\/retry$/)).toHaveLength(1);
    expect(calls.some((c) => c.path.includes(`sha=${LATER}`))).toBe(true);
  });

  test("refuses an open merge request, a closed one, a named wave and one merged elsewhere, and retries nothing", async () => {
    const w: World = {
      mrs: [mr(2), mr(4, { state: "closed" }), merged(), mr(5, { state: "merged", merge_commit_sha: MERGE, target_branch: "release" })],
      notes: { 2: [note(21, "/plywood up")], 4: [note(41, "/plywood up")], 3: [note(32, "/plywood up wave-2")], 5: [note(51, "/plywood up")] },
      members,
      pipelines,
      jobs: applyJobs,
    };
    const got = await poll(w, { jobs });
    expect(got.outcomes.map((o) => o.reason)).toEqual([
      "!2 is not merged, and this project updates after a merge request merges, never from its branch",
      "!4 was closed without merging, so there is nothing of it to update",
      "GitLab runs the waves after a retried apply job by itself, so `wave-2` cannot stop them; write `/plywood up`, and each wave still waits behind its own gate",
      "!5 was merged into release, not the default branch main, so nothing applies from it",
    ]);
    expect(posts(/\/retry$/)).toEqual([]);
  });

  test("refuses a merge commit a later apply superseded, naming that run", async () => {
    const w: World = {
      mrs: [merged()],
      notes: { 3: [note(41, "/plywood up")] },
      members,
      pipelines: [...pipelines, { id: 12, sha: LATER, ref: "main", source: "push" }],
      jobs: applyJobs,
      statuses: { [LATER]: [{ id: 1, name: "plywood/apply", status: "success", target_url: "http://gitlab/acme/infra/-/pipelines/12" }] },
    };
    const got = await poll(w, { jobs });
    expect(got.outcomes[0]!.reason).toBe(`a later apply already ran on main at ${LATER.slice(0, 8)} (http://gitlab/acme/infra/-/pipelines/12), so the merge commit ${MERGE.slice(0, 8)} of !3 is not applied: comment on the merge request that commit came from, or push again`);
    expect(posts(/\/retry$/)).toEqual([]);
  });

  test("says so when every apply job succeeded, one is still running, or no pipeline ran at the merge commit", async () => {
    const done = await poll({ mrs: [merged()], notes: { 3: [note(41, "/plywood up")] }, members, pipelines, jobs: { 10: [{ id: 2, name: "apply-wave-1", status: "success" }] } }, { jobs });
    expect(done.outcomes[0]!.reason).toBe(`every apply job of !3's merge commit ${MERGE.slice(0, 8)} already succeeded`);
    const running = await poll({ mrs: [merged()], notes: { 3: [note(41, "/plywood up")] }, members, pipelines, jobs: { 10: [{ id: 2, name: "apply", status: "running" }] } }, { jobs });
    expect(running.outcomes[0]!.reason).toBe(`apply at ${MERGE.slice(0, 8)} is running already, so it is not retried`);
    const none = await poll({ mrs: [merged()], notes: { 3: [note(41, "/plywood up")] }, members, pipelines: [] }, { jobs });
    expect(none.outcomes[0]!.reason).toBe(`no pipeline at the merge commit ${MERGE.slice(0, 8)} of !3 has an apply job, so there is nothing to retry; push to main again`);
    expect(posts(/\/retry$/)).toEqual([]);
  });

  test("a Reporter's apply retries nothing and gets no reply", async () => {
    const w: World = { mrs: [merged()], notes: { 3: [note(41, "/plywood up", "rita")] }, members, pipelines, jobs: applyJobs };
    expect((await poll(w, { jobs })).outcomes[0]).toMatchObject({ ran: false, replied: false });
    expect(posts(/\/retry$/)).toEqual([]);
    expect(replies(w, 3)).toEqual([]);
  });

  test("the apply jobs: chant's, a member's and terragucci's shares", () => {
    for (const name of ["apply", "apply-wave-3", "api-apply-wave-1", "apply-wave-2-share-4"]) expect(APPLY_JOBS.test(name)).toBe(true);
    for (const name of ["plan", "comment-preview", "apply-wave-0", "applying"]) expect(APPLY_JOBS.test(name)).toBe(false);
  });
});

describe("ledgerNoteLog", () => {
  const git = (dir: string, ...args: string[]): void => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };

  test("records an answered note as _notes/<mr>-<note>.json on chant/lifecycle", async () => {
    await withTestDir(async (dir) => {
      git(dir, "init", "-q", "-b", "main");
      git(dir, "config", "user.email", "test@chant.dev");
      git(dir, "config", "user.name", "Test");
      writeFileSync(join(dir, "README.md"), "x\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "init");
      const log = ledgerNoteLog({ cwd: dir, push: false });
      expect(await log.answered(3, 41)).toBe(false);
      await log.record({ mr: 3, note: 41, ran: true, replied: true, reason: "started", at: NOW.toISOString() });
      expect(await log.answered(3, 41)).toBe(true);
      expect(await log.answered(3, 42)).toBe(false);
      const shown = spawnSync("git", ["show", "chant/lifecycle:_notes/3-41.json"], { cwd: dir, encoding: "utf-8" });
      expect(JSON.parse(shown.stdout)).toMatchObject({ mr: 3, note: 41, ran: true });
    });
  });
});
