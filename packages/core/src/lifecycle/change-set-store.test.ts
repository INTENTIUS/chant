/**
 * Stored change sets (#4022) against temp git repos: the store, the gate's
 * call that maps and stores, `chant change-set show`'s document and the link
 * a gate in `workspace status` carries. Graph reads are injected here;
 * `gate-change-set.e2e.test.ts` reads a real one.
 */

import { describe, expect, test } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeChangeSet, lifecyclePlanPart, type ChangeSetDocument } from "../change-set";
import type { ChangeSet as LifecycleChangeSet } from "./change-set";
import { CHANGE_SETS_DIR, changeSetFile, ChangeSetStoreError, persistChangeSet, readStoredChangeSet } from "./change-set-store";
import { storeGateChangeSet } from "./gate-change-set";
import { appendPendingGate } from "./gate-ledger";
import { writeLedgerFiles } from "./git";
import { clearMemberLedgerCache } from "./member-ledger";
import { changeSetShowDocument } from "../workspace/change-set-show";
import { readMemberGates } from "../workspace/status-gates";
import { loadAjv2020 } from "../workspace/ajv2020";
import showSchema from "../workspace/change-set-show.schema.json";
import changeSetSchema from "../workspace/change-set.schema.json";

const plan = JSON.parse(readFileSync(join(import.meta.dirname, "..", "__fixtures__", "change-set", "lifecycle-plan.floci.json"), "utf8")) as LifecycleChangeSet;
const doc = (): ChangeSetDocument => composeChangeSet([lifecyclePlanPart({ member: "queues", plan })]);

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function initRepo(dir: string): string {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@chant.dev");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return git(dir, "rev-parse", "HEAD");
}

function validator(schema: object) {
  const Ajv = loadAjv2020();
  const ajv = new Ajv({ strict: false, allErrors: true }) as unknown as { compile(s: object): ((d: unknown) => boolean) & { errors?: unknown } };
  return ajv.compile(schema);
}

describe("persistChangeSet and readStoredChangeSet", () => {
  test("stores a document under its digest once, and reads it back", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const d = doc();
      expect(await readStoredChangeSet(d.digest, { cwd: dir })).toEqual({ status: "missing" });
      const first = await persistChangeSet(d, { cwd: dir });
      expect(first.written).toBe(true);
      expect(git(dir, "ls-tree", "--name-only", `chant/lifecycle:${CHANGE_SETS_DIR}`)).toBe(changeSetFile(d.digest));
      expect(changeSetFile(d.digest)).not.toContain(":");
      const again = await persistChangeSet(d, { cwd: dir });
      expect(again).toEqual({ commit: null, written: false });
      const read = await readStoredChangeSet(d.digest, { cwd: dir });
      expect(read).toEqual({ status: "found", document: JSON.parse(JSON.stringify(d)) });
    });
  });

  test("refuses a document that does not hash to its digest", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const d = doc();
      const forged = { ...d, entries: d.entries.slice(1) };
      await expect(persistChangeSet(forged, { cwd: dir })).rejects.toBeInstanceOf(ChangeSetStoreError);
      await expect(persistChangeSet({ ...d, $schema: "x" } as never, { cwd: dir })).rejects.toBeInstanceOf(ChangeSetStoreError);
    });
  });

  test("a file under a digest that is not that document reads as malformed", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const d = doc();
      const other = { ...d, entries: d.entries.slice(1) };
      await writeLedgerFiles([{ path: `${CHANGE_SETS_DIR}/${changeSetFile(d.digest)}`, content: JSON.stringify(other), expectPriorSha: null }], "forged", { cwd: dir });
      const read = await readStoredChangeSet(d.digest, { cwd: dir });
      expect(read.status).toBe("malformed");
    });
  });
});

describe("storeGateChangeSet", () => {
  test("maps the entries onto the graph it reads, and stores in the member's ledger", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      writeFileSync(join(dir, "chant.workspace.json"), JSON.stringify({ name: "acme", schema: 1, members: [{ name: "delivery", dir: "delivery", kind: "chant" }] }));
      mkdirSync(join(dir, "delivery"));
      clearMemberLedgerCache();
      const d = doc();
      const reads: string[] = [];
      const stored = await storeGateChangeSet({
        doc: d,
        cwd: join(dir, "delivery"),
        at: "c".repeat(40),
        readGraph: async (at) => {
          reads.push(at);
          return { ids: ["jobs", "events", "dlq"] };
        },
      });
      expect(stored).toEqual({ digest: d.digest, written: true, graph: { member: "delivery", at: "c".repeat(40) } });
      expect(reads).toEqual([join(dir, "delivery")]);
      expect(git(dir, "ls-tree", "-r", "--name-only", "chant/lifecycle")).toBe(`_members/delivery/${CHANGE_SETS_DIR}/${changeSetFile(d.digest)}`);

      // Stored already: the graph is not read again.
      expect(await storeGateChangeSet({ doc: d, cwd: join(dir, "delivery"), readGraph: async () => { throw new Error("read again"); } })).toEqual({ digest: d.digest, written: false });

      // chant change-set show, from the workspace root with --member, and from the member's directory.
      const shown = await changeSetShowDocument({ cwd: dir, digest: d.digest, member: ["delivery"] });
      expect(validator(showSchema)(shown)).toBe(true);
      if ("error" in shown) throw new Error(shown.error.message);
      expect(shown.member).toBe("delivery");
      expect(shown.reason).toBeNull();
      expect(validator(changeSetSchema)(shown.changeSet)).toBe(true);
      expect(shown.changeSet!.entries.map((e) => [e.address, e.node])).toEqual([
        ["alerts", null],
        ["dlq", "delivery/dlq"],
        ["events", "delivery/events"],
        ["jobs", "delivery/jobs"],
      ]);
      const fromMember = await changeSetShowDocument({ cwd: join(dir, "delivery"), digest: d.digest });
      expect(fromMember).toEqual(shown);
      // The flat ledger holds nothing under that digest.
      const flat = await changeSetShowDocument({ cwd: dir, digest: d.digest });
      expect(flat).toMatchObject({ member: null, changeSet: null, reason: null });
      expect(validator(showSchema)(flat)).toBe(true);
    });
  });

  test("a graph that can't be read stores the document with null nodes and says why", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      clearMemberLedgerCache();
      const d = doc();
      const stored = await storeGateChangeSet({ doc: d, cwd: dir, readGraph: async () => ({ error: "chant graph --format ir exited 1" }) });
      expect(stored.written).toBe(true);
      expect(stored.graph).toBeNull();
      expect(stored.warning).toContain("exited 1");
      const read = await readStoredChangeSet(d.digest, { cwd: dir });
      if (read.status !== "found") throw new Error(read.status);
      expect(read.document.graph).toBeNull();
      expect(read.document.entries.every((e) => e.node === null)).toBe(true);
    });
  });

  test("show reports a malformed file and a checkout with no git", async () => {
    await withTestDir(async (dir) => {
      const outside = await changeSetShowDocument({ cwd: dir, digest: doc().digest });
      expect(outside).toMatchObject({ error: { code: "not-a-git-repository" } });
      expect(validator(showSchema)(outside)).toBe(true);
      initRepo(dir);
      clearMemberLedgerCache();
      const d = doc();
      await writeLedgerFiles([{ path: `${CHANGE_SETS_DIR}/${changeSetFile(d.digest)}`, content: "{", expectPriorSha: null }], "broken", { cwd: dir });
      const shown = await changeSetShowDocument({ cwd: dir, digest: d.digest });
      expect(shown).toMatchObject({ changeSet: null, reason: { code: "ledger-malformed" } });
      expect(validator(showSchema)(shown)).toBe(true);
    });
  });
});

describe("a gate in workspace status links to its stored change set", () => {
  test("a gate whose planDigest names a stored change set carries changeSet; a component gate does not", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      clearMemberLedgerCache();
      const d = doc();
      await storeGateChangeSet({ doc: d, cwd: dir, readGraph: async () => ({ ids: ["jobs"] }) });
      const now = "2026-10-16T00:00:00.000Z";
      const later = "2026-10-17T00:00:00.000Z";
      await appendPendingGate({ op: "pr-7", gate: "pr-apply", planDigest: d.digest, timestamp: now, expiresAt: later }, { cwd: dir });
      const lifecyclePlan = "jcs1-sha256:" + "0".repeat(64);
      await appendPendingGate({ op: "api", gate: "prod-approval", planDigest: lifecyclePlan, environment: "prod", timestamp: now, expiresAt: later }, { cwd: dir });
      const commit = git(dir, "rev-parse", "chant/lifecycle");
      const { gates } = await readMemberGates("_gates", "flat", commit, ["prod"], dir, now);
      const byOp = Object.fromEntries(gates.map((g) => [g.component, g]));
      expect(byOp["pr-7"]).toMatchObject({ state: "pending", planDigest: d.digest, changeSet: d.digest });
      expect(byOp.api.planDigest).toBe(lifecyclePlan);
      expect(byOp.api).not.toHaveProperty("changeSet");
    });
  });
});

describe("a release gate's stored change set (#4045)", () => {
  test("names the release and environment it was planned for, and a release gate in status names its release", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      clearMemberLedgerCache();
      const releaseDigest = "jcs1-sha256:" + "a".repeat(64);
      const d = composeChangeSet([lifecyclePlanPart({ member: "queues", plan })], { planned: { releaseDigest, environment: "prod" } });
      await storeGateChangeSet({ doc: d, cwd: dir, readGraph: async () => ({ ids: ["jobs"] }) });
      const read = await readStoredChangeSet(d.digest, { cwd: dir });
      if (read.status !== "found") throw new Error(read.status);
      expect(read.document).toMatchObject({ releaseDigest, environment: "prod" });
      expect(validator(changeSetSchema)(read.document)).toBe(true);
      const shown = await changeSetShowDocument({ cwd: dir, digest: d.digest });
      expect(shown).toMatchObject({ changeSet: { releaseDigest, environment: "prod" } });
      expect(validator(showSchema)(shown)).toBe(true);

      const now = "2026-10-16T00:00:00.000Z";
      await appendPendingGate(
        { op: "release", gate: "prod-release", planDigest: d.digest, environment: "prod", releaseDigest, timestamp: now, expiresAt: "2026-10-17T00:00:00.000Z" },
        { cwd: dir },
      );
      const commit = git(dir, "rev-parse", "chant/lifecycle");
      const { gates } = await readMemberGates("_gates", "flat", commit, ["prod"], dir, now);
      expect(gates).toEqual([expect.objectContaining({ component: "release", releaseDigest, changeSet: d.digest, state: "pending" })]);
    });
  });
});
