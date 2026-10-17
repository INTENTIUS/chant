/**
 * Stored change sets mapped onto a real graph (#4022).
 *
 * The estate is the aws source `__fixtures__/change-set/lifecycle-v2.ts.txt`
 * as a workspace member, and the change set is
 * `__fixtures__/change-set/lifecycle-plan.floci.json`, chant's real plan of
 * that source against floci (see `../change-set.test.ts`). The graph is the
 * member's own `chant graph --format ir`, run by `storeGateChangeSet` as a
 * pull-request apply runs it, and the ids are checked against `chant
 * workspace graph`, which is what behold reads. The stored document is then
 * read back through `chant change-set show --json`, and the gate that binds
 * it through `workspace status`'s gate reader.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { composeChangeSet, lifecyclePlanPart } from "../change-set";
import type { ChangeSet as LifecycleChangeSet } from "./change-set";
import { storeGateChangeSet } from "./gate-change-set";
import { appendPendingGate } from "./gate-ledger";
import { clearMemberLedgerCache } from "./member-ledger";
import { readMemberGates } from "../workspace/status-gates";

const REPO = realpathSync(join(import.meta.dirname, "..", "..", "..", ".."));
const LOADER = join(REPO, "node_modules", "tsx", "dist", "loader.mjs");
const MAIN = join(REPO, "packages", "core", "src", "cli", "main.ts");
const FIXTURES = join(import.meta.dirname, "..", "__fixtures__", "change-set");
const TIMEOUT = 240_000;

function chant(cwd: string, ...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", `file://${LOADER}`, MAIN, ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("a change set stored by a gate, on a real estate's graph", () => {
  let root: string;
  let member: string;
  const git = (...a: string[]) => {
    const r = spawnSync("git", a, { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const plan = JSON.parse(readFileSync(join(FIXTURES, "lifecycle-plan.floci.json"), "utf8")) as LifecycleChangeSet;
  const doc = composeChangeSet([lifecyclePlanPart({ member: "queues", plan })]);

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "chant-change-set-graph-")));
    member = join(root, "delivery");
    mkdirSync(member);
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"));
    writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({ name: "acme", schema: 1, members: [{ name: "delivery", dir: "delivery", kind: "chant" }] }));
    writeFileSync(join(member, "chant.config.json"), JSON.stringify({ lexicons: ["aws"] }));
    writeFileSync(join(member, "queues.ts"), readFileSync(join(FIXTURES, "lifecycle-v2.ts.txt"), "utf8"));
    writeFileSync(join(root, ".gitignore"), "node_modules\n");
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ci@example.test");
    git("config", "user.name", "ci");
    git("add", "-A");
    git("commit", "-qm", "queues");
    clearMemberLedgerCache();
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test("each entry carries the node chant workspace graph gives its address", async () => {
    const head = git("rev-parse", "HEAD");
    const stored = await storeGateChangeSet({ doc, cwd: member, at: head });
    expect(stored.warning).toBeUndefined();
    expect(stored).toMatchObject({ digest: doc.digest, written: true, graph: { member: "delivery", at: head } });

    const graph = chant(root, "workspace", "graph");
    expect(graph.code, graph.stderr).toBe(0);
    const nodeIds = new Set((JSON.parse(graph.stdout) as { nodes: Array<{ id: string }> }).nodes.map((n) => n.id));

    const shown = chant(member, "change-set", "show", doc.digest, "--json");
    expect(shown.code, shown.stderr).toBe(0);
    const out = JSON.parse(shown.stdout);
    expect(out).toMatchObject({ contract: 1, member: "delivery", digest: doc.digest, reason: null });
    expect(out.changeSet.digest).toBe(doc.digest);
    expect(out.changeSet.graph).toEqual({ member: "delivery", at: head });
    const nodes = Object.fromEntries((out.changeSet.entries as Array<{ address: string; node: string | null }>).map((e) => [e.address, e.node]));
    // jobs, events and dlq are declared; alerts is a live topic v2 no longer declares, so it has no node.
    expect(nodes).toEqual({ alerts: null, dlq: "delivery/dlq", events: "delivery/events", jobs: "delivery/jobs" });
    for (const node of Object.values(nodes)) if (node !== null) expect(nodeIds.has(node), node).toBe(true);

    // From the workspace root, by --member.
    const fromRoot = chant(root, "change-set", "show", doc.digest, "--member", "delivery", "--json");
    expect(JSON.parse(fromRoot.stdout)).toEqual(out);

    // Without --json: the grouped summary, then each change on its node.
    const text = chant(member, "change-set", "show", doc.digest);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain(`Nodes from the graph of delivery at ${head.slice(0, 12)}:`);
    expect(text.stdout).toMatch(/create\s+queues {2}dlq {2}delivery\/dlq/);
  }, TIMEOUT);

  test("the gate that binds it links to it in workspace status", async () => {
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 3_600_000).toISOString();
    await appendPendingGate({ op: "pr-7-delivery", gate: "pr-apply", planDigest: doc.digest, timestamp: now, expiresAt: later }, { cwd: member });
    const { gates } = await readMemberGates("_members/delivery/_gates", "members", git("rev-parse", "chant/lifecycle"), [], root, now);
    expect(gates).toEqual([expect.objectContaining({ component: "pr-7-delivery", state: "pending", planDigest: doc.digest, changeSet: doc.digest })]);

    const status = chant(root, "workspace", "status", "dev", "--json");
    expect(status.stdout, status.stderr).not.toBe("");
    const gate = (JSON.parse(status.stdout).members as Array<{ name: string; gates?: Array<{ component: string; changeSet?: string }> }>)
      .find((m) => m.name === "delivery")
      ?.gates?.find((g) => g.component === "pr-7-delivery");
    expect(gate?.changeSet, status.stderr).toBe(doc.digest);
  }, TIMEOUT);

  test("a digest nothing is stored under shows no change set and exits 1", () => {
    const missing = chant(member, "change-set", "show", `jcs1-sha256:${"0".repeat(64)}`, "--json");
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({ member: "delivery", changeSet: null, reason: null });
  }, TIMEOUT);
});
