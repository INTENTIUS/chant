/**
 * #4928: `runStateMigration` takes the product's record of the migration (its
 * moves, retags, stamps), which the request's attachment binds beside the
 * roots as canonical JSON, bounded in size. On the in-memory engine and
 * ledger; nothing reaches a store or git.
 */
import { describe, expect, test } from "vitest";
import { fakeLedger } from "./__fixtures__/gated-ledger";
import type { RequestGateInput } from "./lifecycle/gated-request";
import { NEXT_RELEASE } from "./release-floors";
import {
  runStateMigration,
  STATE_MIGRATION_RECORD_FLOOR,
  STATE_MIGRATION_RECORD_MAX_BYTES,
  StateMigrationRecordError,
  type MigrationRootPlan,
  type StateMigrationEngine,
} from "./state-migration";

const roots: MigrationRootPlan[] = [
  { root: "queues", location: "s3://acme/queues.tfstate", before: { version_id: "q1", digest: "sha256:q-before" }, after: { digest: "sha256:q-after" }, proof: { changes: [], summary: "No changes." } },
];

const engine: StateMigrationEngine = {
  lock: async () => async () => {},
  current: async () => ({ version_id: "q1", digest: "sha256:q-before" }),
  write: async () => {},
  verify: async () => ({ changes: [], summary: "No changes." }),
};

/** A ledger that keeps each request's attachment. */
function ledger() {
  const l = fakeLedger();
  const attachments: Array<string | undefined> = [];
  const ask = l.requestGate.bind(l);
  l.requestGate = (input: RequestGateInput) => {
    attachments.push(input.attachment);
    return ask(input);
  };
  return Object.assign(l, { attachments });
}

const run = (l: ReturnType<typeof ledger>, record?: unknown) =>
  runStateMigration({ name: "move-queues", by: "ana", roots, engine, words: { op: "tf-migrate" }, rules: { mode: "ledger" }, ledger: l, now: "2026-11-09T09:00:00Z", ...(record !== undefined ? { record } : {}) });

const record = { moves: [{ from: "envs/dev/platform", to: "envs/dev/queues", addresses: ["aws_sqs_queue.jobs"] }], retags: [], stamps: [{ root: "envs/dev/queues", estate: "dev" }] };

describe("runStateMigration's record (#4928)", () => {
  test("the attachment carries the record beside the roots, with its keys sorted, so the digest binds it", async () => {
    const l = ledger();
    const r = await run(l, record);
    expect(r.status).toBe("waiting");
    const doc = JSON.parse(l.attachments[0]!) as { name: string; roots: unknown[]; record: Record<string, unknown> };
    expect(doc.name).toBe("move-queues");
    expect(doc.roots).toHaveLength(1);
    expect(doc.record).toEqual(record);
    expect(Object.keys(doc.record)).toEqual(["moves", "retags", "stamps"]);
    expect(Object.keys((doc.record.moves as object[])[0]!)).toEqual(["addresses", "from", "to"]);
  });

  test("the same record in another key order asks under the same digest; another record, or none, under another", async () => {
    const digest = async (rec?: unknown) => {
      const r = await run(ledger(), rec);
      return r.status === "waiting" ? r.digest : "";
    };
    const reordered = { stamps: record.stamps, retags: [], moves: [{ addresses: ["aws_sqs_queue.jobs"], to: "envs/dev/queues", from: "envs/dev/platform" }] };
    expect(await digest(reordered)).toBe(await digest(record));
    expect(await digest({ ...record, stamps: [] })).not.toBe(await digest(record));
    expect(await digest()).not.toBe(await digest(record));
  });

  test("with no record the attachment is the roots alone, as before", async () => {
    const l = ledger();
    await run(l);
    expect(Object.keys(JSON.parse(l.attachments[0]!) as object)).toEqual(["name", "roots"]);
  });

  test("a record over the bound, or one that is not JSON, throws before anything is asked", async () => {
    const l = ledger();
    const big = { stamps: [{ note: "x".repeat(STATE_MIGRATION_RECORD_MAX_BYTES) }] };
    await expect(run(l, big)).rejects.toThrow(StateMigrationRecordError);
    await expect(run(l, { at: 1n })).rejects.toThrow(/not JSON/);
    expect(l.writes).toEqual([]);
    expect(l.attachments).toEqual([]);
  });

  test("the floor is the next release", () => {
    expect(STATE_MIGRATION_RECORD_FLOOR).toBe(NEXT_RELEASE);
  });
});
