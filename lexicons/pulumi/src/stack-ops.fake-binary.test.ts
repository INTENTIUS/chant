/**
 * The gated stack operations on core's adapters (#4808), against a fake
 * `pulumi` binary over a local file backend: the export of one version, the
 * live-run check before a cancel, and the check that nothing moved between a
 * move's plan and its write. The fake is a node script written per test that
 * keeps its stacks, history and locks under a temp directory laid out as a
 * file backend (`.pulumi/stacks`, `.pulumi/history`, `.pulumi/locks`); with
 * `cloud` it numbers its updates and exports any of them by `--version`, as
 * Pulumi Cloud does. The ledger is in memory, digesting with chant's own
 * `gatedRequestDigest`.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { gatedRequestDigest, type GatedRequest } from "@intentius/chant/lifecycle/gated-request-digest";
import type { LiveRun } from "@intentius/chant/state-unlock";
import { engineRunnerAt, type PulumiRunner } from "./run";
import { gatedStackCancel, gatedStackExport, gatedStackMove, PulumiStackOpRefused, type GatedRequestApi, type PulumiStackOpCommon } from "./stack-ops";

function ledger() {
  const pending: { digest: string; request: GatedRequest }[] = [];
  const approvals = new Map<string, string>();
  const spent = new Set<string>();
  const finished: { digest: string; result: string; detail?: Record<string, unknown> }[] = [];
  const api: GatedRequestApi = {
    async readGatedRequests(op) {
      return pending.map((p) => ({ op, gate: p.request.subject, digest: p.digest, request: p.request, pending: {} as never, approvals: [], ...(spent.has(p.digest) ? { applied: {} as never } : {}) }));
    },
    async requestGate(input) {
      const digest = gatedRequestDigest(input.op, input.request);
      if (spent.has(digest)) return { status: "spent", digest, request: input.request };
      if (!pending.some((p) => p.digest === digest)) pending.push({ digest, request: input.request });
      const by = approvals.get(digest);
      const command = `chant approve ${input.op} ${input.request.subject} --plan ${digest}`;
      if (!by) return { status: "waiting", digest, request: input.request, command };
      if (by === input.request.by) return { status: "refused", digest, request: input.request, by, reason: "the requester's own approval does not count", command };
      return { status: "approved", digest, request: input.request, approval: { version: 1, op: input.op, gate: input.request.subject, resolvedBy: by, timestamp: "2026-11-09T12:00:00Z" } as never };
    },
    async spendGatedRequest(input) {
      spent.add(input.digest);
      return { version: 1, kind: "applied", op: input.op, gate: input.gate, planDigest: input.digest, approvedAt: input.approval.timestamp, approvedBy: input.approval.resolvedBy, timestamp: "2026-11-09T12:01:00Z" };
    },
    async finishGatedRequest(input) {
      finished.push({ digest: input.digest, result: input.result, ...(input.detail ? { detail: input.detail } : {}) });
      return { record: {} as never, pushed: true };
    },
  };
  return { api, pending, approve: (digest: string, by: string) => approvals.set(digest, by), finished, spent };
}

const FAKE = String.raw`
const fs = require("fs"), path = require("path");
const root = __ROOT__;
const cloud = __CLOUD__;
const a = process.argv.slice(2);
fs.appendFileSync(path.join(root, "calls.log"), JSON.stringify(a) + "\n");
const stackOf = () => a[a.indexOf("--stack") + 1];
const state = (s) => path.join(root, ".pulumi", "stacks", "shop", s + ".json");
const hist = (s) => path.join(root, ".pulumi", "history", "shop", s);
const versions = (s) => (fs.existsSync(hist(s)) ? fs.readdirSync(hist(s)).map((f) => Number(f.split(".")[0])).sort((x, y) => x - y) : []);
const locks = (s) => path.join(root, ".pulumi", "locks", "organization", "shop", s);
const fail = (m) => { process.stderr.write("error: " + m + "\n"); process.exit(255); };
const out = (t) => { process.stdout.write(t); process.exit(0); };
if (a[0] === "stack" && a[1] === "export") {
  const s = stackOf();
  const vi = a.indexOf("--version");
  if (vi >= 0) {
    if (!cloud) fail("the current backend (fake) does not provide the ability to export previous deployments");
    const f = path.join(hist(s), a[vi + 1] + ".json");
    if (!fs.existsSync(f)) fail("no version " + a[vi + 1]);
    out(fs.readFileSync(f, "utf8"));
  }
  if (!fs.existsSync(state(s))) fail("no stack named " + s);
  out(fs.readFileSync(state(s), "utf8"));
}
if (a[0] === "stack" && a[1] === "history") {
  const v = versions(stackOf());
  out(JSON.stringify([{ version: cloud && v.length ? v[v.length - 1] : 0, kind: "update", result: "succeeded" }]));
}
if (a[0] === "cancel") {
  const d = locks(stackOf());
  if (!fs.existsSync(d) || fs.readdirSync(d).length === 0) fail("no update is in progress");
  // Released locks move aside to released/, so the fake deletes nothing.
  const gone = path.join(root, "released");
  fs.mkdirSync(gone, { recursive: true });
  for (const f of fs.readdirSync(d)) fs.renameSync(path.join(d, f), path.join(gone, f));
  out("The currently running update for '" + stackOf() + "' has been canceled!\n");
}
if (a[0] === "preview") {
  const f = path.join(root, "preview", stackOf() + ".json");
  out(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : JSON.stringify({ steps: [], changeSummary: {} }));
}
if (a[0] === "state" && a[1] === "move") {
  const src = a[3], dst = a[5], urns = a.slice(7);
  const from = JSON.parse(fs.readFileSync(state(src), "utf8"));
  const to = JSON.parse(fs.readFileSync(state(dst), "utf8"));
  const moving = from.deployment.resources.filter((r) => urns.includes(r.urn));
  from.deployment.resources = from.deployment.resources.filter((r) => !urns.includes(r.urn));
  to.deployment.resources.push(...moving.map((r) => ({ ...r, urn: r.urn.replace("urn:pulumi:" + src + "::", "urn:pulumi:" + dst + "::") })));
  fs.writeFileSync(state(src), JSON.stringify(from));
  fs.writeFileSync(state(dst), JSON.stringify(to));
  for (const s of [src, dst]) fs.writeFileSync(path.join(root, "preview", s + ".json"), JSON.stringify({ steps: [], changeSummary: {} }));
  out("");
}
fail("the fake pulumi does not know " + a.join(" "));
`;

const exportDoc = (resources: { urn: string; type: string }[], time = "2026-11-09T10:00:00Z") => JSON.stringify({ version: 3, deployment: { manifest: { time }, resources: resources.map((r) => ({ ...r, custom: true })) } });

/** A file backend, a stack directory naming it, and a fake `pulumi` over it. */
function backend(opts: { cloud?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "stack-ops-backend-"));
  mkdirSync(join(root, ".pulumi", "stacks", "shop"), { recursive: true });
  mkdirSync(join(root, "preview"));
  writeFileSync(join(root, "calls.log"), "");
  const bin = join(root, "pulumi");
  writeFileSync(bin, `#!/usr/bin/env node\n${FAKE.replace("__ROOT__", JSON.stringify(root)).replace("__CLOUD__", String(opts.cloud === true))}`);
  chmodSync(bin, 0o755);
  const dir = mkdtempSync(join(tmpdir(), "stack-ops-dir-"));
  writeFileSync(join(dir, "Pulumi.yaml"), `name: shop\nruntime: nodejs\nbackend:\n  url: file://${root}\n`);
  return {
    root,
    dir,
    run: engineRunnerAt(bin),
    setState: (stack: string, text: string) => writeFileSync(join(root, ".pulumi", "stacks", "shop", `${stack}.json`), text),
    setVersion: (stack: string, n: number, text: string) => {
      mkdirSync(join(root, ".pulumi", "history", "shop", stack), { recursive: true });
      writeFileSync(join(root, ".pulumi", "history", "shop", stack, `${n}.json`), text);
    },
    setPreview: (stack: string, steps: unknown[]) => writeFileSync(join(root, "preview", `${stack}.json`), JSON.stringify({ steps, changeSummary: {} })),
    lock: (stack: string, id: string, timestamp: string) => {
      const d = join(root, ".pulumi", "locks", "organization", "shop", stack);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, `${id}.json`), JSON.stringify({ pid: 4242, username: "ci", hostname: "runner-7", timestamp }));
    },
    locks: (stack: string) => {
      const d = join(root, ".pulumi", "locks", "organization", "shop", stack);
      return existsSync(d) ? readdirSync(d) : [];
    },
    calls: (): string[][] =>
      readFileSync(join(root, "calls.log"), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]),
  };
}

const outside = (): string => mkdtempSync(join(tmpdir(), "stack-ops-out-"));
const bucket = (stack: string, name: string) => ({ urn: `urn:pulumi:${stack}::shop::aws:s3/bucketV2:BucketV2::${name}`, type: "aws:s3/bucketV2:BucketV2" });

describe("export by version (#4808)", () => {
  test("on a backend that numbers its updates, the request binds the version asked for, and the approved call exports that version", async () => {
    const b = backend({ cloud: true });
    const v = [1, 2, 3].map((n) => exportDoc([bucket("dev", `b${n}`)], `2026-11-0${n}T00:00:00Z`));
    v.forEach((text, i) => b.setVersion("dev", i + 1, text));
    b.setState("dev", v[2]!);
    const l = ledger();
    const out = join(outside(), "dev.v2.json");
    const opts = { by: "alice", rules: { mode: "ledger" as const }, gated: l.api, env: {}, run: b.run, dir: b.dir, stack: "dev", engine: "pulumi" as const, out, version: "2" };

    const first = await gatedStackExport(opts);
    expect(first.status).toBe("waiting");
    expect(first.request).toMatchObject({ kind: "stack-export", subject: "dev", fields: { version_id: "2" } });
    expect(b.calls().some((c) => c.includes("--version"))).toBe(false);
    expect(existsSync(out)).toBe(false);

    l.approve(first.digest, "bob");
    const done = await gatedStackExport(opts);
    expect(done).toMatchObject({ status: "done", digest: first.digest, result: { file: out, version: "2", resources: 1 } });
    expect(readFileSync(out, "utf-8")).toBe(v[1]);
    expect(b.calls()).toContainEqual(["stack", "export", "--stack", "dev", "--version", "2"]);
    expect(l.finished[0]).toMatchObject({ result: "applied", detail: { version_id: "2", approved_by: "bob" } });

    // A version the stack never had is refused before anything is asked.
    await expect(gatedStackExport({ ...opts, version: "9", out: join(outside(), "x.json") })).rejects.toThrow(/has no version 9/);
    expect(l.pending).toHaveLength(1);
  });

  test("on a file backend the version is the export's digest, so a stack that changed after the approval asks again before writing", async () => {
    const b = backend();
    b.setState("dev", exportDoc([bucket("dev", "a")]));
    const l = ledger();
    const out = join(outside(), "dev.json");
    const opts = { by: "alice", rules: { mode: "ledger" as const }, gated: l.api, env: {}, run: b.run, dir: b.dir, stack: "dev", engine: "pulumi" as const, out };

    const first = await gatedStackExport(opts);
    expect(first.status).toBe("waiting");
    expect(first.request.fields.version_id).toMatch(/^sha256:[0-9a-f]{64}$/);
    l.approve(first.digest, "bob");

    // An update lands between the approval and the export: the approval was for the state before it.
    const newer = exportDoc([bucket("dev", "a"), bucket("dev", "b")], "2026-11-09T11:00:00Z");
    b.setState("dev", newer);
    const again = await gatedStackExport(opts);
    expect(again.status).toBe("waiting");
    expect(again.digest).not.toBe(first.digest);
    expect(existsSync(out)).toBe(false);
    expect(l.spent.size).toBe(0);

    l.approve(again.digest, "bob");
    expect(await gatedStackExport(opts)).toMatchObject({ status: "done", result: { resources: 2 } });
    expect(readFileSync(out, "utf-8")).toBe(newer);

    // A numbered version on a backend that keeps none is refused before anything is asked.
    await expect(gatedStackExport({ ...opts, version: "2", out: join(outside(), "y.json") })).rejects.toThrow(/has no version 2/);
  });
});

describe("cancel checks the live runs (#4808)", () => {
  const lockedAt = "2026-11-09T10:00:00Z";
  const run = (started: string): LiveRun => ({ id: "77", status: "in_progress", started, url: "https://forge.example/acme/shop/actions/runs/77" });

  test("a run that began before the lock was taken refuses the release, and nothing is asked", async () => {
    const b = backend();
    b.lock("dev", "lock-1", lockedAt);
    const l = ledger();
    const call = gatedStackCancel({ by: "alice", rules: { mode: "ledger" }, gated: l.api, env: {}, run: b.run, dir: b.dir, stack: "dev", engine: "pulumi", lockId: "lock-1", liveRuns: async () => [run("2026-11-09T09:58:00Z")] });
    await expect(call).rejects.toBeInstanceOf(PulumiStackOpRefused);
    await expect(call).rejects.toMatchObject({ code: "live-run" });
    await expect(call).rejects.toThrow(/run 77 \(in_progress/);
    expect(l.pending).toEqual([]);
    expect(b.locks("dev")).toEqual(["lock-1.json"]);
  });

  test("with no live run it waits, and once approved runs pulumi cancel and checks the lock file is gone", async () => {
    const b = backend();
    b.lock("dev", "lock-1", lockedAt);
    const l = ledger();
    const opts = { by: "alice", rules: { mode: "ledger" as const }, gated: l.api, env: {}, run: b.run, dir: b.dir, stack: "dev", engine: "pulumi" as const, lockId: "lock-1", liveRuns: async () => [run("2026-11-09T11:00:00Z")] };
    const asked = await gatedStackCancel(opts);
    expect(asked.status).toBe("waiting");
    expect(asked.request).toMatchObject({ kind: "stack-cancel", subject: "dev", fields: { id: "lock-1" } });
    l.approve(asked.digest, "bob");
    const done = await gatedStackCancel(opts);
    expect(done).toMatchObject({ status: "done", result: { lockChecked: true, liveRuns: 1 } });
    expect(b.calls()).toContainEqual(["cancel", "--yes", "--stack", "dev"]);
    expect(b.locks("dev")).toEqual([]);
    expect(l.finished[0]).toMatchObject({ result: "applied", detail: { lock_id: "lock-1", locked_by: "ci@runner-7", locked_at: lockedAt, approved_by: "bob" } });
  });

  test("a run that comes back after the approval holds the release, and the approval stays unspent", async () => {
    const b = backend();
    b.lock("dev", "lock-1", lockedAt);
    const l = ledger();
    let reads = 0;
    const liveRuns = async () => (++reads >= 3 ? [run("2026-11-09T09:59:00Z")] : []);
    const opts = { by: "alice", rules: { mode: "ledger" as const }, gated: l.api, env: {}, run: b.run, dir: b.dir, stack: "dev", engine: "pulumi" as const, lockId: "lock-1", liveRuns };
    l.approve((await gatedStackCancel(opts)).digest, "bob");
    await expect(gatedStackCancel(opts)).rejects.toMatchObject({ code: "held" });
    expect(l.spent.size).toBe(0);
    expect(b.calls().some((c) => c[0] === "cancel")).toBe(false);
    expect(b.locks("dev")).toEqual(["lock-1.json"]);
  });

  test("with no runs reader and no forge in the environment, the release is refused: nothing says the holder is gone", async () => {
    const b = backend();
    b.lock("dev", "lock-1", lockedAt);
    const l = ledger();
    await expect(gatedStackCancel({ by: "alice", rules: { mode: "ledger" }, gated: l.api, env: {}, run: b.run, dir: b.dir, stack: "dev", engine: "pulumi", lockId: "lock-1" })).rejects.toThrow(/runs could not be read/);
    expect(l.pending).toEqual([]);
  });
});

describe("move checks nothing moved since its plan (#4808)", () => {
  const logs = (stack: string) => bucket(stack, "logs");
  const step = (op: string, urn: string) => ({ op, urn, type: "aws:s3/bucketV2:BucketV2", provider: "", ...(op === "create" ? { newState: { type: "aws:s3/bucketV2:BucketV2", inputs: {} } } : { oldState: { type: "aws:s3/bucketV2:BucketV2", inputs: {} } }) });
  /** Two stacks on one file backend, net holding the bucket and app's program declaring it. */
  function twoStacks() {
    const b = backend();
    b.setState("net", exportDoc([logs("net"), bucket("net", "keep")]));
    b.setState("app", exportDoc([]));
    b.setPreview("net", [step("delete", logs("net").urn)]);
    b.setPreview("app", [step("create", logs("app").urn)]);
    const appDir = mkdtempSync(join(tmpdir(), "stack-ops-dir-"));
    writeFileSync(join(appDir, "Pulumi.yaml"), readFileSync(join(b.dir, "Pulumi.yaml"), "utf-8"));
    return { b, appDir };
  }
  const common = (l: ReturnType<typeof ledger>, run: PulumiRunner, b: ReturnType<typeof backend>, appDir: string): PulumiStackOpCommon & Parameters<typeof gatedStackMove>[0] => ({
    by: "alice",
    rules: { mode: "ledger" },
    gated: l.api,
    env: {},
    run,
    engine: "pulumi",
    source: { member: "shop/net", dir: b.dir, stack: "net" },
    dest: { member: "shop/app", dir: appDir, stack: "app" },
    urns: [logs("net").urn],
  });

  test("plans both stacks, waits, moves with pulumi state move, and both preview clean after", async () => {
    const { b, appDir } = twoStacks();
    const l = ledger();
    const opts = common(l, b.run, b, appDir);
    const asked = await gatedStackMove(opts);
    expect(asked.status).toBe("waiting");
    expect(asked.request).toMatchObject({ kind: "stack-move", subject: "move:net:app", fields: { urns: logs("net").urn, proof: expect.stringMatching(/^sha256:/) } });
    expect(b.calls().some((c) => c[0] === "state")).toBe(false);
    l.approve(asked.digest, "bob");
    const done = await gatedStackMove(opts);
    expect(done).toMatchObject({ status: "done", result: { engine: "pulumi", moved: [logs("net").urn] } });
    expect(b.calls().filter((c) => c[0] === "state")).toEqual([["state", "move", "--source", "net", "--dest", "app", "--yes", logs("net").urn]]);
    expect(l.finished[0]).toMatchObject({ result: "applied", detail: { afterNoChange: true, result: "applied", "shop/net.before_digest": expect.stringMatching(/^sha256:/) } });
  });

  test("a state that changes between the plan and the write refuses the move under the locks, and nothing moves", async () => {
    const { b, appDir } = twoStacks();
    const l = ledger();
    const asked = await gatedStackMove(common(l, b.run, b, appDir));
    l.approve(asked.digest, "bob");
    // The approved call exports both stacks for its plan; an update lands on net before the move reads them again under the locks.
    let exports = 0;
    const racing: PulumiRunner = async (args, o) => {
      if (args[0] === "stack" && args[1] === "export" && ++exports === 3) b.setState("net", exportDoc([logs("net"), bucket("net", "keep"), bucket("net", "new")]));
      return b.run(args, o);
    };
    const moved = await gatedStackMove(common(l, racing, b, appDir));
    expect(moved).toMatchObject({ status: "failed", check: "moved", error: expect.stringMatching(/shop\/net.*changed since the plan/) });
    expect(b.calls().some((c) => c[0] === "state")).toBe(false);
    expect(l.spent.size).toBe(1);
    expect(l.finished[0]).toMatchObject({ result: "failed", detail: { result: "refused", moved: "shop/net" } });
  });
});
