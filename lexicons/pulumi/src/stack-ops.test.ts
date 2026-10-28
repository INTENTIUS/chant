/**
 * Gated stack operations (#4578): export, cancel and move each run only
 * after their gated request (#4551) is approved, and each write goes
 * through its fixed argv. The gated-request API is an in-memory fake that
 * digests with chant's own `gatedRequestDigest`, and the runners are fakes
 * answering with recorded documents (`testdata/pulumi-preview`), so no
 * binary runs and no ledger or backend is written.
 */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { gatedRequestDigest, type GatedRequest } from "@intentius/chant/lifecycle/gated-request-digest";
import type { PulumiRunner } from "./run";
import {
  diyStackLockIds,
  gatedStackCancel,
  gatedStackExport,
  gatedStackMove,
  moveLeftovers,
  pulumiStackLockIds,
  PULUMI_STACK_OPS_OP,
  type GatedRequestApi,
  type PulumiStackOpCommon,
} from "./stack-ops";

const exportText = readFileSync(join(import.meta.dirname, "testdata", "pulumi-preview", "stack-export.json"), "utf-8");

/** An in-memory ledger: requests wait until `approve` is called by someone other than the requester. */
function ledger() {
  const pending: { digest: string; request: GatedRequest; applied?: boolean }[] = [];
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
      return { status: "approved", digest, request: input.request, approval: { version: 1, op: input.op, gate: input.request.subject, resolvedBy: by, timestamp: "2026-10-27T12:00:00Z" } as never };
    },
    async spendGatedRequest(input) {
      spent.add(input.digest);
      return { version: 1, kind: "applied", op: input.op, gate: input.gate, planDigest: input.digest, approvedAt: input.approval.timestamp, approvedBy: input.approval.resolvedBy, timestamp: "2026-10-27T12:01:00Z" };
    },
    async finishGatedRequest(input) {
      finished.push({ digest: input.digest, result: input.result, ...(input.detail ? { detail: input.detail } : {}) });
      return { record: {} as never, pushed: true };
    },
  };
  return { api, pending, approve: (digest: string, by: string) => approvals.set(digest, by), finished, spent };
}

function runner(answer: (args: string[]) => string | Error = () => "{}"): { run: PulumiRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: PulumiRunner = async (args) => {
    calls.push(args);
    const out = answer(args);
    if (out instanceof Error) throw out;
    return { stdout: out };
  };
  return { run, calls };
}

const outside = (): string => mkdtempSync(join(tmpdir(), "stack-ops-out-"));
/** A stack directory outside any git working tree, with a Pulumi.yaml and an optional backend. */
function stackDir(backend?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "stack-ops-stack-"));
  writeFileSync(join(dir, "Pulumi.yaml"), `name: shop\nruntime: nodejs\n${backend ? `backend:\n  url: ${backend}\n` : ""}`);
  return dir;
}

describe("export", () => {
  test("waits for a second identity, then writes the export mode 600 on the requester's machine only", async () => {
    const l = ledger();
    const pulumi = runner(() => exportText);
    const out = join(outside(), "dev.json");
    const common: PulumiStackOpCommon = { by: "alice", rules: { mode: "ledger" }, gated: l.api, env: {}, run: pulumi.run };
    const first = await gatedStackExport({ ...common, dir: stackDir(), stack: "dev", engine: "pulumi", out });
    expect(first.status).toBe("waiting");
    expect(pulumi.calls).toEqual([]);
    expect(first.request).toMatchObject({ kind: "stack-export", subject: "dev", fields: { stack: "dev", engine: "pulumi", deliver: "requester" } });

    l.approve(first.digest, "alice");
    expect((await gatedStackExport({ ...common, dir: stackDir(), stack: "dev", engine: "pulumi", out })).status).toBe("refused");

    l.approve(first.digest, "bob");
    const done = await gatedStackExport({ ...common, dir: stackDir(), stack: "dev", engine: "pulumi", out });
    expect(done.status).toBe("done");
    expect(done.digest).toBe(first.digest);
    expect(pulumi.calls).toEqual([["stack", "export", "--stack", "dev"]]);
    expect(readFileSync(out, "utf-8")).toBe(exportText);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(l.finished[0]).toMatchObject({ result: "applied", detail: { resources: expect.any(Number) } });
    expect(JSON.stringify(l.finished)).not.toContain("ciphertext");

    expect((await gatedStackExport({ ...common, dir: stackDir(), stack: "dev", engine: "pulumi", out: join(outside(), "again.json") })).status).toBe("spent");
  });

  test("refused in CI, inside a git working tree, and over an existing file, before anything is asked", async () => {
    const l = ledger();
    const base = { by: "alice", rules: { mode: "ledger" as const }, gated: l.api, dir: stackDir(), stack: "dev", engine: "pulumi" as const };
    await expect(gatedStackExport({ ...base, env: { CI: "true" }, out: join(outside(), "x.json") })).rejects.toThrow(/CI is set/);
    const repo = outside();
    mkdirSync(join(repo, ".git"));
    await expect(gatedStackExport({ ...base, env: {}, out: join(repo, "x.json") })).rejects.toThrow(/inside the git working tree/);
    const taken = join(outside(), "taken.json");
    writeFileSync(taken, "{}");
    await expect(gatedStackExport({ ...base, env: {}, out: taken })).rejects.toThrow(/never overwrites/);
    expect(l.pending).toEqual([]);
  });
});

describe("cancel", () => {
  test("releases the lock only while it is the approved one, on a file:// backend", async () => {
    const root = outside();
    const locks = join(root, ".pulumi", "locks", "organization", "shop", "dev");
    mkdirSync(locks, { recursive: true });
    writeFileSync(join(locks, "lock-1.json"), "{}");
    expect(diyStackLockIds(root, "shop", "dev")).toEqual(["lock-1"]);

    const dir = stackDir(`file://${root}`);
    const l = ledger();
    const pulumi = runner();
    const common = { by: "alice", rules: { mode: "ledger" as const }, gated: l.api, env: {}, run: pulumi.run, dir, stack: "dev", engine: "pulumi" as const };

    const stale = await gatedStackCancel({ ...common, lockId: "lock-0" });
    l.approve(stale.digest, "bob");
    await expect(gatedStackCancel({ ...common, lockId: "lock-0" })).rejects.toThrow(/not the one it holds now \(lock-1\)/);
    expect(l.spent.size).toBe(0);

    const asked = await gatedStackCancel({ ...common, lockId: "lock-1" });
    expect(asked.status).toBe("waiting");
    l.approve(asked.digest, "bob");
    const done = await gatedStackCancel({ ...common, lockId: "lock-1" });
    expect(done).toMatchObject({ status: "done", result: { lockChecked: true } });
    expect(pulumi.calls).toEqual([["cancel", "--yes", "--stack", "dev"]]);
  });

  test("a stack on plunge is refused: plunge keeps no stack lock", async () => {
    const l = ledger();
    await expect(gatedStackCancel({ by: "alice", rules: { mode: "ledger" }, gated: l.api, env: {}, dir: stackDir(), stack: "dev", engine: "plunge", lockId: "x" })).rejects.toThrow(/keeps no stack lock/);
  });
});

const src = (name: string) => `urn:pulumi:net::shop::aws:s3/bucketV2:BucketV2::${name}`;
const dst = (name: string) => `urn:pulumi:app::shop::aws:s3/bucketV2:BucketV2::${name}`;
const step = (op: string, urn: string) => ({ op, urn, type: "aws:s3/bucketV2:BucketV2", provider: "", ...(op === "create" ? { newState: { type: "aws:s3/bucketV2:BucketV2", inputs: {} } } : { oldState: { type: "aws:s3/bucketV2:BucketV2", inputs: {} } }) });
const previewDoc = (steps: unknown[]) => JSON.stringify({ steps, changeSummary: {} });

describe("move", () => {
  test("moveLeftovers is empty only when the previews change nothing but the moved resources", async () => {
    const { pulumiPreviewPart } = await import("./change-set");
    const source = pulumiPreviewPart({ member: "net", preview: JSON.parse(previewDoc([step("delete", src("logs"))])) });
    const dest = pulumiPreviewPart({ member: "app", preview: JSON.parse(previewDoc([step("create", dst("logs"))])) });
    expect(moveLeftovers([src("logs")], source, dest)).toEqual([]);
    const other = pulumiPreviewPart({ member: "app", preview: JSON.parse(previewDoc([step("create", dst("logs")), step("create", dst("extra"))])) });
    expect(moveLeftovers([src("logs")], source, other)).toEqual([`app: create ${dst("extra")}`]);
    const unmoved = pulumiPreviewPart({ member: "app", preview: JSON.parse(previewDoc([])) });
    expect(moveLeftovers([src("logs")], source, unmoved)[0]).toMatch(/does not create/);
  });

  test("stock: previews both, waits, moves with pulumi state move, and previews both again", async () => {
    const l = ledger();
    let moved = false;
    const pulumi = runner((args) => {
      if (args[0] === "state") {
        moved = true;
        return "";
      }
      const stack = args[args.indexOf("--stack") + 1];
      if (moved) return previewDoc([]);
      return stack === "net" ? previewDoc([step("delete", src("logs"))]) : previewDoc([step("create", dst("logs"))]);
    });
    const opts = {
      by: "alice",
      rules: { mode: "ledger" as const },
      gated: l.api,
      env: {},
      run: pulumi.run,
      engine: "pulumi" as const,
      source: { member: "net", dir: stackDir(), stack: "net" },
      dest: { member: "app", dir: stackDir(), stack: "app" },
      urns: [src("logs")],
    };
    const asked = await gatedStackMove(opts);
    expect(asked.status).toBe("waiting");
    expect(asked.request).toMatchObject({ kind: "stack-move", subject: "move:net:app", fields: { urns: src("logs") } });
    l.approve(asked.digest, "bob");
    const done = await gatedStackMove(opts);
    expect(done.status).toBe("done");
    expect(pulumi.calls.filter((c) => c[0] === "state")).toEqual([["state", "move", "--source", "net", "--dest", "app", "--yes", src("logs")]]);
    expect(l.finished[0]).toMatchObject({ result: "applied", detail: { afterNoChange: true } });
  });

  test("a preview that changes more than the move refuses after approval, leaving it unspent", async () => {
    const l = ledger();
    const pulumi = runner((args) => (args[args.indexOf("--stack") + 1] === "net" ? previewDoc([step("delete", src("logs")), step("delete", src("other"))]) : previewDoc([step("create", dst("logs"))])));
    const opts = { by: "alice", rules: { mode: "ledger" as const }, gated: l.api, env: {}, run: pulumi.run, engine: "pulumi" as const, source: { member: "net", dir: stackDir(), stack: "net" }, dest: { member: "app", dir: stackDir(), stack: "app" }, urns: [src("logs")] };
    l.approve((await gatedStackMove(opts)).digest, "bob");
    await expect(gatedStackMove(opts)).rejects.toThrow(/change more than the moved resources.*delete .*other/);
    expect(l.spent.size).toBe(0);
    expect(pulumi.calls.some((c) => c[0] === "state")).toBe(false);
  });

  test("plunge: the plan must be planned, then plunge stack move --json --yes runs", async () => {
    const l = ledger();
    let moved = false;
    const plunge = runner((args) => {
      if (args[0] === "stack" && args[1] === "move") {
        if (args.includes("--yes")) {
          moved = true;
          return JSON.stringify({ status: "moved", result: { source: "net", destination: "app", written: true, resources: [] } });
        }
        return JSON.stringify({ status: "planned", result: { source: "net", destination: "app", written: false, resources: [] } });
      }
      const stack = args[args.indexOf("--stack") + 1];
      if (moved) return previewDoc([]);
      return stack === "net" ? previewDoc([step("delete", src("logs"))]) : previewDoc([step("create", dst("logs"))]);
    });
    const opts = { by: "alice", rules: { mode: "ledger" as const }, gated: l.api, env: {}, plunge: plunge.run, engine: "plunge" as const, source: { member: "net", dir: stackDir(), stack: "net" }, dest: { member: "app", dir: stackDir(), stack: "app" }, urns: [src("logs")] };
    l.approve((await gatedStackMove(opts)).digest, "bob");
    const done = await gatedStackMove(opts);
    expect(done.status).toBe("done");
    expect(plunge.calls.filter((c) => c[1] === "move")).toEqual([
      ["stack", "move", "--stack", "net", "--dest", "app", src("logs"), "--json"],
      ["stack", "move", "--stack", "net", "--dest", "app", src("logs"), "--json", "--yes"],
    ]);
  });

  test("a refused plunge plan refuses the move", async () => {
    const l = ledger();
    const plunge = runner((args) => {
      if (args[1] === "move") return Object.assign(new Error("exit 255"), { code: 255, stdout: JSON.stringify({ status: "refused", refusals: [{ urn: src("logs"), reason: "the destination already owns a resource of that URN" }] }) });
      return args[args.indexOf("--stack") + 1] === "net" ? previewDoc([step("delete", src("logs"))]) : previewDoc([step("create", dst("logs"))]);
    });
    const opts = { by: "alice", rules: { mode: "ledger" as const }, gated: l.api, env: {}, plunge: plunge.run, engine: "plunge" as const, source: { member: "net", dir: stackDir(), stack: "net" }, dest: { member: "app", dir: stackDir(), stack: "app" }, urns: [src("logs")] };
    l.approve((await gatedStackMove(opts)).digest, "bob");
    await expect(gatedStackMove(opts)).rejects.toThrow(/plan is refused: .*already owns/);
    expect(l.spent.size).toBe(0);
  });

  test("the requests sit under one op", () => {
    expect(PULUMI_STACK_OPS_OP).toBe("pulumi-stack-ops");
  });
});

describe("the stack lock reader (chant#4615)", () => {
  test("lists a file:// backend's current lock ids for the stack, both layouts", async () => {
    const root = outside();
    mkdirSync(join(root, ".pulumi", "locks", "organization", "shop", "dev"), { recursive: true });
    writeFileSync(join(root, ".pulumi", "locks", "organization", "shop", "dev", "lock-2.json"), "{}");
    mkdirSync(join(root, ".pulumi", "locks", "dev"), { recursive: true });
    writeFileSync(join(root, ".pulumi", "locks", "dev", "lock-1.json"), "{}");
    const dir = stackDir(`file://${root}`);
    expect(await pulumiStackLockIds({ dir, stack: "dev", env: {} })).toEqual({ checked: true, backend: `file://${root}`, ids: ["lock-1", "lock-2"] });
    expect(await pulumiStackLockIds({ dir, stack: "prod", env: {} })).toEqual({ checked: true, backend: `file://${root}`, ids: [] });
  });

  test("takes PULUMI_BACKEND_URL over Pulumi.yaml, and says it did not read a backend it cannot list", async () => {
    const root = outside();
    mkdirSync(join(root, ".pulumi", "locks", "organization", "shop", "dev"), { recursive: true });
    writeFileSync(join(root, ".pulumi", "locks", "organization", "shop", "dev", "lock-9.json"), "{}");
    const dir = stackDir("s3://bucket");
    expect(await pulumiStackLockIds({ dir, stack: "dev", env: {} })).toEqual({ checked: false, backend: "s3://bucket", ids: [] });
    expect((await pulumiStackLockIds({ dir, stack: "dev", env: { PULUMI_BACKEND_URL: `file://${root}` } })).ids).toEqual(["lock-9"]);
  });

  test("a plunge stack holds no stack lock", async () => {
    const dir = stackDir(`file://${outside()}`);
    expect(await pulumiStackLockIds({ dir, stack: "dev", engine: "plunge", env: {} })).toEqual({ checked: true, ids: [] });
  });
});
