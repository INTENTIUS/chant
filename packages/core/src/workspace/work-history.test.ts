/**
 * #2785 — `chant workspace work history <id>`: a work item's lease history,
 * each claim with how it ended, from the ledger of the member that owns the
 * work kind, so a runner counts failed builds without reading git itself.
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, REPO, repo } from "./__fixtures__/contract-repo";
import { claimWorkLease, releaseWorkLease, renewWorkLease, type LeaseHistoryRecord } from "../lifecycle/work-lease";
import { claimsOf, formatWorkHistory, workHistory, type WorkHistoryDocument } from "./work-cli";
import historySchema from "./work-history.schema.json";

const REF = join(REPO, "reference-workspace");
const { expectValid } = contract(historySchema);

function work(id: string): string {
  const data = { schema: 1, id, title: `Work ${id}`, state: "open", implements: [], needs: [], constrains: ["path:app/server.mjs"], evidence: [], opened_on: "2026-09-25", source: { kind: "workspace", member: "app" }, supersedes: [] };
  return `---\n${JSON.stringify(data, null, 2)}\n---\n\n# ${id}\n`;
}

let root: string;
let kindDir: string;

beforeAll(() => {
  // The work kind sits in the design member, so its leases are in that member's ledger.
  root = repo({
    "chant.workspace.json": JSON.stringify(
      {
        name: "studio",
        schema: 1,
        members: [
          { name: "app", dir: "app", kind: "other", because: "a plain Node server" },
          { name: "design", dir: "design", kind: "other", because: "records only" },
        ],
        records: [{ kind: "design/decisions/decision.kind.mjs" }, { kind: "design/work/work.kind.mjs" }],
      },
      null,
      2,
    ),
    "app/server.mjs": "export const port = 8080;\n",
    "design/decisions/decision.kind.mjs": readFileSync(join(REF, "decisions", "decision.kind.mjs"), "utf-8"),
    "design/decisions/decision.schema.json": readFileSync(join(REF, "decisions", "decision.schema.json"), "utf-8"),
    "design/work/work.kind.mjs": readFileSync(join(REF, "work", "work.kind.mjs"), "utf-8"),
    "design/work/work.schema.json": readFileSync(join(REF, "work", "work.schema.json"), "utf-8"),
    "design/work/W-001-one.md": work("W-001"),
    "design/work/W-002-two.md": work("W-002"),
  });
  git(root, "config", "user.name", "History Test");
  git(root, "config", "user.email", "history@example.com");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "the queue");
  kindDir = join(root, "design", "work");
});
afterAll(cleanScratch);

const at = (min: number) => () => new Date(Date.UTC(2020, 0, 1, 12, min));

describe("workspace work history (#2785)", () => {
  test("each claim with its token and holder, and how it ended: released with an outcome, lost, expired or held", async () => {
    const opts = (min: number) => ({ cwd: kindDir, now: at(min), ttlMs: 10 * 60_000 });
    // A build that ended not_done.
    const first = await claimWorkLease("W-001", "steward/dispatch@1", opts(0));
    if (!first.ok) throw new Error(first.message);
    await renewWorkLease("W-001", "steward/dispatch@1", { ...opts(3), token: first.lease.token });
    await releaseWorkLease("W-001", "steward/dispatch@1", { cwd: kindDir, now: at(5), token: first.lease.token, outcome: "not_done" });
    // A build whose lease ran out unreleased, and another worker then claimed the item.
    const second = await claimWorkLease("W-001", "steward/dispatch@2", opts(10));
    if (!second.ok) throw new Error(second.message);
    const third = await claimWorkLease("W-001", "steward/dispatch@3", opts(30));
    if (!third.ok) throw new Error(third.message);

    const doc = await workHistory({ id: "W-001", cwd: root });
    expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc).toMatchObject({
      item: "W-001",
      kind: "design/work/work.kind.mjs",
      ref: "refs/chant/lease/_members/design/work/W-001",
      ledger: { branch: "chant/lifecycle", path: "_members/design/_leases/W-001.jsonl" },
      malformed: 0,
    });
    expect(doc.claims.map((c) => [c.holder, c.token, c.ended, c.renewals, c.release?.outcome ?? null])).toEqual([
      ["steward/dispatch@1", first.lease.token, "released", 1, "not_done"],
      ["steward/dispatch@2", second.lease.token, "lost", 0, null],
      ["steward/dispatch@3", third.lease.token, "expired", 0, null],
    ]);
    expect(doc.events.map((e) => e.event)).toEqual(["claim", "renew", "release", "claim", "claim"]);
    expect(doc.summary).toEqual({ claims: 3, released: 1, held: 0, expired: 1, lost: 1, outcomes: { not_done: 1 } });
    // The history file is where git would find it, under the member's prefix.
    expect(git(root, "show", `chant/lifecycle:${doc.ledger.path}`).split("\n")).toHaveLength(5);
    expect(formatWorkHistory(doc)).toContain("released not_done by steward/dispatch@1");
  });

  test("a live claim is held, and a done release is counted by outcome", async () => {
    const now = () => new Date();
    const done = await claimWorkLease("W-002", "worker-a", { cwd: kindDir, now });
    if (!done.ok) throw new Error(done.message);
    await releaseWorkLease("W-002", "worker-a", { cwd: kindDir, now, token: done.lease.token, outcome: "done" });
    const live = await claimWorkLease("W-002", "worker-b", { cwd: kindDir, now });
    if (!live.ok) throw new Error(live.message);

    const doc = await workHistory({ id: "W-002", cwd: kindDir, kind: join(kindDir, "work.kind.mjs") });
    expectValid(doc);
    if ("error" in doc) throw new Error(doc.error.message);
    expect(doc.claims.map((c) => c.ended)).toEqual(["released", "held"]);
    expect(doc.lease).toMatchObject({ holder: "worker-b", token: live.lease.token, state: "active" });
    expect(doc.summary.outcomes).toEqual({ done: 1 });
  });

  test("an item never claimed has no claims; an unknown item is an error", async () => {
    const W3 = join(kindDir, "W-003-three.md");
    writeFileSync(W3, work("W-003"));
    try {
      const none = await workHistory({ id: "W-003", cwd: root });
      expectValid(none);
      expect(none).toMatchObject({ claims: [], events: [], lease: null, summary: { claims: 0 } });
    } finally {
      rmSync(W3);
    }
    const unknown = await workHistory({ id: "W-404", cwd: root });
    expectValid(unknown);
    expect(unknown).toMatchObject({ error: { code: "work-item-unknown" } });
    const bad = await workHistory({ id: "../x", cwd: root });
    expect((bad as Extract<WorkHistoryDocument, { error: unknown }>).error.code).toBe("work-item-unknown");
  });
});

describe("claimsOf", () => {
  const e = (event: LeaseHistoryRecord["event"], token: string, extra: Partial<LeaseHistoryRecord> = {}): LeaseHistoryRecord => ({
    version: 1,
    event,
    item: "W",
    holder: `h-${token}`,
    by: `h-${token}`,
    token,
    acquiredAt: "2026-09-25T00:00:00.000Z",
    expiresAt: "2026-09-25T00:10:00.000Z",
    timestamp: "2026-09-25T00:00:00.000Z",
    ...extra,
  });

  test("a release by someone closing out an expired lease keeps the holder and records who released it", () => {
    const claims = claimsOf([e("claim", "a"), e("release", "a", { by: "janitor", outcome: "expired" })], null);
    expect(claims).toEqual([
      { token: "a", holder: "h-a", acquiredAt: "2026-09-25T00:00:00.000Z", expiresAt: "2026-09-25T00:10:00.000Z", renewals: 0, ended: "released", release: { by: "janitor", at: "2026-09-25T00:00:00.000Z", outcome: "expired", note: null } },
    ]);
  });

  test("the live ref decides between held and expired for the newest claim", () => {
    expect(claimsOf([e("claim", "a")], { token: "a", state: "active" })[0].ended).toBe("held");
    expect(claimsOf([e("claim", "a")], { token: "a", state: "expired" })[0].ended).toBe("expired");
    expect(claimsOf([e("claim", "a"), e("claim", "b")], { token: "b", state: "active" }).map((c) => c.ended)).toEqual(["lost", "held"]);
  });
});
