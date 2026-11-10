/**
 * #4762: the engine-neutral state migration, on an in-memory engine and an
 * in-memory gated-request ledger. Nothing reaches a store or git.
 */
import { describe, expect, test } from "vitest";
import { fakeLedger } from "./__fixtures__/gated-ledger";
import { NEXT_RELEASE } from "./release-floors";
import { runStateMigration, STATE_MIGRATION_FLOOR, STATE_MIGRATION_SOURCE_FLOOR, writeStateMigration, type MigrationRootPlan, type MigrationStateAt, type StateMigrationEngine } from "./state-migration";

const plan = (proof: string[] = []): MigrationRootPlan[] => [
  { root: "queues", location: "s3://acme/queues.tfstate", before: { version_id: "q1", digest: "sha256:q-before" }, after: { digest: "sha256:q-after" }, proof: { changes: [], summary: "No changes." } },
  { root: "platform", location: "s3://acme/platform.tfstate", before: { version_id: "p1", digest: "sha256:p-before" }, after: { digest: "sha256:p-after" }, proof: { changes: proof, summary: proof.length ? "Plan: 1 to add" : "No changes." } },
];

/** An engine over states in memory: `now` is what `current` reads, `write` moves every root to its new version. */
function engine(opts: { moved?: string; failWrite?: boolean; leftChange?: string } = {}): StateMigrationEngine & { calls: string[]; locked: boolean } {
  const calls: string[] = [];
  const now = new Map<string, MigrationStateAt>([
    ["queues", { version_id: "q1", digest: "sha256:q-before" }],
    ["platform", { version_id: opts.moved === "platform" ? "p2" : "p1", digest: "sha256:p-before" }],
  ]);
  const e = {
    calls,
    locked: false,
    async lock() {
      calls.push("lock");
      e.locked = true;
      return async () => {
        calls.push("release");
        e.locked = false;
      };
    },
    async current(root: string) {
      calls.push(`current ${root}`);
      return now.get(root)!;
    },
    async write() {
      calls.push("write");
      if (opts.failWrite) throw new Error("state push in queues failed");
    },
    async verify(root: string) {
      calls.push(`verify ${root}`);
      return { changes: root === opts.leftChange ? ["aws_sqs_queue.jobs: create"] : [], summary: "No changes.", version_id: `${root[0]}2` };
    },
  };
  return e;
}

const base = (ledger: ReturnType<typeof fakeLedger>, e: StateMigrationEngine, roots = plan()) => ({
  name: "move-queues",
  by: "ana",
  roots,
  engine: e,
  words: { op: "tf-migrate", approveCommand: (s: string, d: string) => `product approve ${s} --plan ${d}` },
  fields: { file: "migrations/move-queues.yml", file_digest: "sha256:file" },
  rules: { mode: "ledger" as const },
  ledger,
  now: "2026-11-08T09:00:00Z",
});

describe("runStateMigration", () => {
  test("a proof that shows a change is refused before anything is asked", async () => {
    const ledger = fakeLedger();
    const e = engine();
    const r = await runStateMigration(base(ledger, e, plan(["aws_sqs_queue.jobs: create"])));
    expect(r).toMatchObject({ status: "proof-failed", exit: 1, failing: ["platform"] });
    expect(ledger.writes).toEqual([]);
    expect(e.calls).toEqual([]);
  });

  test("waits for an approval of the proof, then writes under the locks, checks the states, and records each root's versions", async () => {
    const ledger = fakeLedger();
    const e = engine();
    const first = await runStateMigration(base(ledger, e));
    expect(first).toMatchObject({ status: "waiting", exit: 3 });
    expect(first.status === "waiting" && first.command).toBe(`product approve move-queues --plan ${first.status === "waiting" ? first.digest : ""}`);
    expect(e.calls).toEqual([]);
    ledger.approve("bo");
    const second = await runStateMigration(base(ledger, e));
    expect(second).toMatchObject({ status: "applied", exit: 0, approvedBy: "bo", digest: first.status === "waiting" ? first.digest : "" });
    expect(e.calls).toEqual(["lock", "current platform", "current queues", "write", "verify platform", "verify queues", "release"]);
    expect(ledger.writes).toEqual(["pending", "applied", "finished:applied"]);
    expect(ledger.details[0]).toMatchObject({ result: "applied", roots: "platform,queues", "platform.before": "p1", "platform.after": "p2", "queues.location": "s3://acme/queues.tfstate", approved_by: "bo", by: "ana" });
    expect(await runStateMigration(base(ledger, e))).toMatchObject({ status: "spent", exit: 0 });
  });

  test("a state that is not the one planned refuses the write under the lock", async () => {
    const ledger = fakeLedger();
    ledger.approve("bo");
    const e = engine({ moved: "platform" });
    const r = await runStateMigration(base(ledger, e));
    expect(r).toMatchObject({ status: "moved", exit: 4 });
    expect(r.status === "moved" && r.result.moved).toEqual(["platform"]);
    expect(e.calls).not.toContain("write");
    expect(e.locked).toBe(false);
    expect(ledger.writes.at(-1)).toBe("finished:failed");
    expect(ledger.details[0]).toMatchObject({ result: "refused", moved: "platform" });
  });

  test("a write that fails, or a change left after it, fails the migration and releases the locks", async () => {
    const ledger = fakeLedger();
    ledger.approve("bo");
    const broken = engine({ failWrite: true });
    const r = await runStateMigration(base(ledger, broken));
    expect(r).toMatchObject({ status: "failed", exit: 1 });
    expect(r.status === "failed" && r.error).toMatch(/the write failed: state push in queues failed/);
    expect(broken.calls.at(-1)).toBe("release");

    const other = fakeLedger();
    other.approve("bo");
    const left = engine({ leftChange: "queues" });
    const l = await runStateMigration(base(other, left));
    expect(l).toMatchObject({ status: "failed", exit: 1, error: "after the write, queues plan changes" });
    expect(other.writes.at(-1)).toBe("finished:failed");
  });

  test("an approval by the requester does not count", async () => {
    const ledger = fakeLedger();
    ledger.approve("ana");
    expect(await runStateMigration(base(ledger, engine()))).toMatchObject({ status: "refused", exit: 3 });
  });

  test("a write a wave's hold approved runs without a request of its own", async () => {
    const e = engine();
    const r = await writeStateMigration(e, plan());
    expect(r.status).toBe("applied");
    expect(e.calls[0]).toBe("lock");
    expect(e.calls.at(-1)).toBe("release");
  });

  test("its floor is the next release", () => {
    expect(STATE_MIGRATION_FLOOR).toBe("0.124.77");
  });
});

describe("a root's source and an approval the states moved away from (#4806)", () => {
  const withSource = (): MigrationRootPlan[] => plan().map((r) => (r.root === "queues" ? { ...r, before: { digest: null }, source: { location: "old.tfstate", digest: "sha256:q-after" } } : r));
  const sourced = (now: MigrationStateAt) => {
    const e = engine();
    e.current = async (root) => (root === "queues" ? { digest: null } : { version_id: "p1", digest: "sha256:p-before" });
    return Object.assign(e, { source: async () => now });
  };

  test("the request binds the source, the finished line names it, and a source that moved refuses the write", async () => {
    const ledger = fakeLedger();
    ledger.approve("bo");
    const ok = await runStateMigration(base(ledger, sourced({ digest: "sha256:q-after" }), withSource()));
    expect(ok.status).toBe("applied");
    expect(ledger.details[0]).toMatchObject({ "queues.source": "old.tfstate" });

    const other = fakeLedger();
    other.approve("bo");
    const e = sourced({ digest: "sha256:q-written-since" });
    const moved = await runStateMigration(base(other, e, withSource()));
    expect(moved.status === "moved" && moved.result.moved).toEqual(["queues"]);
    expect(e.calls).not.toContain("write");

    const plain = fakeLedger();
    const a = await runStateMigration(base(plain, engine(), withSource()));
    const b = await runStateMigration(base(fakeLedger(), engine(), plan()));
    expect(a.status === "waiting" && b.status === "waiting" && a.digest !== b.digest).toBe(true);
  });

  test("a request that waits while an approval of an earlier one stands answers approval-moved, naming the roots that moved", async () => {
    const ledger = fakeLedger();
    const earlier = plan().map((r) => (r.root === "platform" ? { ...r, before: { version_id: "p0", digest: "sha256:p-older" } } : r));
    const attachment = `${JSON.stringify({ name: "move-queues", roots: [...earlier].sort((x, y) => (x.root < y.root ? -1 : 1)).map((r) => ({ root: r.root, location: r.location, before: { version_id: r.before.version_id, digest: r.before.digest }, after: r.after.digest })) })}\n`;
    const read = ledger.readGatedRequests;
    ledger.readGatedRequests = async (op) => [
      ...(await read(op)),
      { op, gate: "move-queues", digest: "sha256:earlier", request: { kind: "migrate", subject: "move-queues", by: "ana", fields: {} }, pending: { timestamp: "2026-11-08T08:00:00Z" } as never, approvals: [{ resolvedBy: "bo", timestamp: "2026-11-08T08:30:00Z" } as never] } as never,
    ];
    const r = await runStateMigration({ ...base(ledger, engine()), readAttachment: async (_op, d) => (d === "sha256:earlier" ? attachment : undefined) });
    expect(r).toMatchObject({ status: "approval-moved", exit: 4, approved: "sha256:earlier", approvedBy: "bo", moved: ["platform"] });

    const own = fakeLedger();
    own.readGatedRequests = async (op) => [{ op, gate: "move-queues", digest: "sha256:earlier", request: { kind: "migrate", subject: "move-queues", by: "ana", fields: {} }, pending: { timestamp: "2026-11-08T08:00:00Z" } as never, approvals: [{ resolvedBy: "ana", timestamp: "2026-11-08T08:30:00Z" } as never] } as never];
    expect((await runStateMigration(base(own, engine()))).status).toBe("waiting");
  });

  test("its floor is the next release", () => {
    expect(STATE_MIGRATION_SOURCE_FLOOR).toBe("0.124.86");
  });
});
