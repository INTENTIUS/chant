/**
 * Overlap between in-flight work items (#4025), in throwaway repositories
 * built on the flag workspace (`__fixtures__/flag-workspace.ts`): its
 * decision kind, work kind and member `shop`.
 *
 * - W-002 and W-003 implement d-002, which is only decided, so both are in
 *   flight. W-001 implements d-001, which is confirmed, so it is not.
 * - Branch `a` changes line 1 of `shop/queue.ts` for W-002. Branch `b`
 *   changes line 20 of the same file for W-003, and exists only as the
 *   remote-tracking `origin/b`. Branch `c` changes it for W-001.
 * - `m` merges `a` and `b`.
 */

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { changeSetDocumentDigest, composeChangeSet, lifecyclePlanPart, type ChangeSetDocument } from "../change-set";
import { readFileSync } from "node:fs";
import type { ChangeSet as LifecycleChangeSet } from "../lifecycle/change-set";
import { storeGateChangeSet } from "../lifecycle/gate-change-set";
import { appendPendingGate } from "../lifecycle/gate-ledger";
import { clearMemberLedgerCache } from "../lifecycle/member-ledger";
import { cleanScratch, contract, git, repo, writeFiles } from "./__fixtures__/contract-repo";
import { flagWorkspace, workItem } from "./__fixtures__/flag-workspace";
import { attributeEntry } from "./overlap";
import { workspaceStatus } from "./status";
import intentSchema from "./intent.schema.json";
import statusSchema from "./status.schema.json";

const plan = JSON.parse(readFileSync(join(import.meta.dirname, "..", "__fixtures__", "change-set", "lifecycle-plan.floci.json"), "utf8")) as LifecycleChangeSet;
const lines = (changed: Record<number, string>) => Array.from({ length: 20 }, (_, i) => changed[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

let root: string;
const sha: Record<string, string> = {};

function commitOn(branch: string, from: string, files: Record<string, string>, item: string): string {
  git(root, "checkout", "-q", "-b", branch, from);
  writeFiles(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", `work on ${item}`, "--trailer", `Chant-Record: ${item}`);
  return git(root, "rev-parse", "HEAD");
}

beforeAll(() => {
  root = flagWorkspace({ "work/W-003-the-queue.md": workItem("W-003", ["d-002"]), "shop/queue.ts": lines({}) });
  git(root, "branch", "-M", "main");
  sha.a = commitOn("a", "main", { "shop/queue.ts": lines({ 1: "a" }) }, "work:W-002");
  sha.b = commitOn("b", "main", { "shop/queue.ts": lines({ 20: "b" }), "shop/other.ts": "b\n" }, "work:W-003");
  sha.c = commitOn("c", "main", { "shop/queue.ts": lines({ 10: "c" }) }, "work:W-001");
  // b exists only as a remote-tracking branch: pushed by someone else and fetched.
  git(root, "update-ref", "refs/remotes/origin/b", sha.b);
  git(root, "checkout", "-q", "main");
  git(root, "branch", "-q", "-D", "b");
  git(root, "checkout", "-q", "-b", "m", "a");
  git(root, "merge", "-q", "--no-edit", "origin/b");
  sha.m = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "main");
});
afterAll(cleanScratch);

const status = () => workspaceStatus({ cwd: root, env: "prod", readLedger: async () => ({ records: [], malformed: 0 }), readPromotionOrder: async () => [] });

describe("attributing a change-set entry to work items (#4025)", () => {
  const commitsOf = new Map([
    ["work:W-002", ["a1"]],
    ["work:W-003", ["b1", "b2"]],
  ]);
  const files = new Map([
    ["a1", ["shop/queue.ts"]],
    ["b1", ["shop/other.ts"]],
    ["b2", ["shop/queue.ts"]],
  ]);

  test("goes to each item with a linked commit that changed the entry's source", () => {
    expect(attributeEntry("shop/queue.ts", commitsOf, files, null)).toEqual(["work:W-002", "work:W-003"]);
    expect(attributeEntry("shop/other.ts", commitsOf, files, null)).toEqual(["work:W-003"]);
    expect(attributeEntry("shop/none.ts", commitsOf, files, null)).toEqual([]);
  });

  test("counts only commits in the history the change set was planned from", () => {
    expect(attributeEntry("shop/queue.ts", commitsOf, files, new Set(["a1"]))).toEqual(["work:W-002"]);
    expect(attributeEntry("shop/queue.ts", commitsOf, files, new Set(["b1"]))).toEqual([]);
  });

  test("an entry with no source goes to no item", () => {
    expect(attributeEntry(undefined, commitsOf, files, null)).toEqual([]);
  });

  test("an entry's source, like its node, stays outside the change set's digest", () => {
    const d = composeChangeSet([lifecyclePlanPart({ member: "queue", plan })]);
    expect(changeSetDocumentDigest({ ...d, entries: d.entries.map((e) => ({ ...e, node: "x", source: "shop/queue.ts" })) })).toBe(d.digest);
  });
});

describe("workspace status --json overlap (#4025)", () => {
  test("two in-flight work items touching one file are a pair; a confirmed item and a remote-only branch are handled", async () => {
    const doc = await status();
    contract(statusSchema).expectValid(doc);
    if ("error" in doc) throw new Error(JSON.stringify(doc));
    expect(doc.overlap).not.toBeNull();
    expect(doc.overlap!.items.map((i) => [i.item, i.state, i.commits])).toEqual([
      ["work:W-002", "in-progress", [sha.a]],
      ["work:W-003", "in-progress", [sha.b]],
    ]);
    expect(doc.overlap!.items[1].path).toBe("work/W-003-the-queue.md");
    // W-001's decision is confirmed, so its commit to the same file is not in flight.
    expect(doc.overlap!.pairs).toEqual([{ items: ["work:W-002", "work:W-003"], files: ["shop/queue.ts"], addresses: [] }]);
    expect(doc.overlap!.changeSets).toEqual([]);
  });

  test("a pending gate's change set: the entry whose source both items changed is a shared address; one planned from a only is not", async () => {
    clearMemberLedgerCache();
    const shop = join(root, "shop");
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const store = async (d: ChangeSetDocument, at: string, op: string) => {
      await storeGateChangeSet({ doc: d, cwd: shop, at, readGraph: async () => ({ ids: ["events", "jobs"], sources: { events: "queue.ts" } }) });
      await appendPendingGate({ op, gate: "prod-release", planDigest: d.digest, environment: "prod", timestamp: now, expiresAt: later }, { cwd: shop });
    };
    const both = composeChangeSet([lifecyclePlanPart({ member: "queue", plan })]);
    const onlyA = composeChangeSet([lifecyclePlanPart({ member: "queue-a", plan })]);
    await store(both, sha.m, "shop");
    await store(onlyA, sha.a, "shop-a");

    const doc = await status();
    contract(statusSchema).expectValid(doc);
    if ("error" in doc) throw new Error(JSON.stringify(doc));
    const gates = doc.members.find((m) => m.name === "shop")!.gates;
    expect(gates.map((g) => g.changeSet).sort()).toEqual([both.digest, onlyA.digest].sort());
    expect(doc.overlap!.changeSets).toEqual([both.digest, onlyA.digest].sort());
    // Each change set has one entry with a source (events); the rest are unattributed.
    expect(doc.overlap!.unattributed).toBe(both.entries.length - 1 + onlyA.entries.length - 1);
    expect(doc.overlap!.pairs).toEqual([
      {
        items: ["work:W-002", "work:W-003"],
        files: ["shop/queue.ts"],
        addresses: [{ changeSet: both.digest, ledgerMember: "shop", member: "queue", address: "events", node: "shop/events", source: "shop/queue.ts" }],
      },
    ]);
  });

  test("the text view lists the pair", async () => {
    const { formatStatus } = await import("./status");
    const doc = await status();
    if ("error" in doc) throw new Error(JSON.stringify(doc));
    expect(formatStatus(doc)).toMatch(/work:W-002 and work:W-003\s+shop\/queue\.ts\s+shop\/events/);
  });

  test("the intent graph document gives each work node the items it overlaps by file", async () => {
    const { intentGraph } = await import("./intent");
    const { doc } = await intentGraph({ cwd: root, region: "shop/queue.ts" });
    contract(intentSchema).expectValid(doc);
    if ("error" in doc) throw new Error(JSON.stringify(doc));
    const work = Object.fromEntries(doc.nodes.filter((n) => n.kind === "work").map((n) => [(n as { record: string }).record, (n as { overlaps?: unknown }).overlaps]));
    expect(work["W-002"]).toEqual([{ with: "work:W-003", files: ["shop/queue.ts"] }]);
    expect(work["W-003"]).toEqual([{ with: "work:W-002", files: ["shop/queue.ts"] }]);
    expect(work["W-001"]).toEqual([]);
  });

  test("null when the workspace declares no work kind", async () => {
    const plain = repo({ "chant.workspace.json": JSON.stringify({ name: "plain", schema: 1, members: [] }) }, true);
    const doc = await workspaceStatus({ cwd: plain, env: "prod", readLedger: async () => ({ records: [], malformed: 0 }) });
    if ("error" in doc) throw new Error(JSON.stringify(doc));
    expect(doc.overlap).toBeNull();
  });
});
