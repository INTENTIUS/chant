/**
 * #2779 — a step whose command stops at a gate of its own stops its run
 * there. The stand-in below behaves like `chant workspace upgrade --json` in
 * the part an Op sees: it reads its gate (`workspace-upgrade` / `<scope>`) on
 * the gate ledger, prints `{ outcome: "gated", pending }` and exits 3 while
 * nobody has approved the pending fact, and applies and commits once someone
 * has.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, commitAll, contract, git, repo } from "../workspace/__fixtures__/contract-repo";
import statusSchema from "../workspace/status.schema.json";
import { readMemberStewards } from "../workspace/status-stewards";
import { appendGateResolution, appendPendingGate } from "../lifecycle/gate-ledger";
import { readRunLedger } from "../lifecycle/run-ledger";
import { readLeaseHistory } from "../lifecycle/work-lease";
import type { ActivityFn, ActivityProfile } from "./activity-registry";
import { shellCmd } from "./activities/shell";
import { runOpLocally } from "./local-executor";
import { formatRoundLine, runOperatorRound } from "./operator";
import { declareSteward } from "./steward";
import { isGateWait } from "./gate-wait";
import { workLeaseOutput } from "./work-lease-run";
import { WORKSPACE_UPGRADE_GATE_OP } from "./gate-name";
import type { OpConfig } from "./types";

const PROFILES: Record<string, ActivityProfile> = { atMostOnce: { timeout: "60s" } };
const ACTIVITIES = new Map<string, ActivityFn>([["shellCmd", ((args, signal) => shellCmd(args as never, signal)) as ActivityFn]]);

/** `chant workspace upgrade <scope> --json`, as far as its gate goes. */
const STAND_IN = `
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const scope = process.argv[2];
let text = "";
try { text = execFileSync("git", ["show", "chant/lifecycle:_gates/workspace-upgrade.jsonl"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
const lines = text.split("\\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.gate === scope);
const pending = lines.filter((l) => l.kind === "pending").at(-1);
if (!pending) { console.error("no pending fact: the test records it"); process.exit(1); }
const approved = lines.some((l) => l.kind !== "pending" && Date.parse(l.timestamp) >= Date.parse(pending.timestamp));
if (!approved) {
  console.log(JSON.stringify({ outcome: "gated", scope, pending }, null, 2));
  process.exit(3);
}
writeFileSync("upgraded-" + scope + ".txt", "upgraded\\n");
execFileSync("git", ["add", "-A"]);
execFileSync("git", ["commit", "-q", "-m", "upgrade " + scope]);
console.log(JSON.stringify({ outcome: "applied", scope }, null, 2));
`;

let root: string;

beforeAll(() => {
  root = repo({ "chant.config.json": "{}\n", "tools/upgrade.mjs": STAND_IN }, false);
  git(root, "config", "user.name", "Gate Test");
  git(root, "config", "user.email", "gate@example.com");
  commitAll(root, "c0");
});
afterAll(cleanScratch);

function upgradeOp(name: string, scope: string, extra: Partial<OpConfig> = {}): OpConfig {
  return {
    name,
    overview: "chant workspace upgrade in a work-lease worktree",
    changesCheckout: true,
    workLease: { item: scope === "." ? "workspace-upgrade" : `upgrade-${scope}` },
    phases: [
      {
        name: "Upgrade",
        steps: [
          {
            kind: "activity",
            fn: "shellCmd",
            id: "upgrade",
            args: { cmd: `node ${JSON.stringify(join(root, "tools", "upgrade.mjs"))} ${scope}`, cwd: workLeaseOutput("worktree"), gatedExit: 3 },
          },
        ],
      },
      { name: "After", steps: [{ kind: "activity", fn: "shellCmd", args: { cmd: "true" } }] },
    ],
    ...extra,
  };
}

/** What `chant workspace upgrade` records when it stages a patch nobody has approved. */
async function stage(scope: string): Promise<string> {
  const timestamp = new Date().toISOString();
  await appendPendingGate(
    { op: WORKSPACE_UPGRADE_GATE_OP, gate: scope, timestamp, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), description: `upgrade ${scope}` },
    { cwd: root },
  );
  return timestamp;
}

async function approve(scope: string): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
  await appendGateResolution({ op: WORKSPACE_UPGRADE_GATE_OP, gate: scope, resolvedBy: "alice", timestamp: new Date().toISOString() }, { cwd: root });
}

describe("shell's gatedExit (#2779)", () => {
  test("the gate comes from the command's JSON, else from the step's gate on the ledger, else the step fails", async () => {
    const pending = { version: 1, kind: "pending", op: "workspace-upgrade", gate: "web", timestamp: "2027-01-01T00:00:00.000Z", expiresAt: "2027-01-03T00:00:00.000Z" };
    const printed = JSON.stringify({ outcome: "gated", pending }, null, 2).replace(/'/g, "");
    const fromJson = await shellCmd({ cmd: `printf '%s' '${printed}'; exit 3`, gatedExit: 3 }).catch((e: unknown) => e);
    expect(isGateWait(fromJson)).toBe(true);
    expect((fromJson as { pending: unknown }).pending).toMatchObject({ op: "workspace-upgrade", gate: "web" });

    const since = await stage("named");
    const named = await shellCmd({ cmd: "exit 3", cwd: root, gatedExit: 3, gate: { op: "workspace-upgrade", gate: "named" } }).catch((e: unknown) => e);
    expect(isGateWait(named)).toBe(true);
    expect((named as { pending: { timestamp: string } }).pending.timestamp).toBe(since);

    await expect(shellCmd({ cmd: "exit 3", gatedExit: 3 })).rejects.toThrow(/named no gate/);
    await expect(shellCmd({ cmd: "exit 3", cwd: root, gatedExit: 3, gate: { op: "workspace-upgrade", gate: "never" } })).rejects.toThrow(/no pending fact/);
    // Another code still fails, and okExit still passes.
    await expect(shellCmd({ cmd: "exit 4", gatedExit: 3 })).rejects.toThrow(/command exited 4/);
    await expect(shellCmd({ cmd: "exit 1", gatedExit: 3, okExit: [0, 1] })).resolves.toMatchObject({ exitCode: 1 });
  });
});

describe("an Op whose step runs chant workspace upgrade in a work-lease worktree (#2779)", () => {
  test("records its first run gated with the gate, releases the lease gated, and applies once approved", async () => {
    const since = await stage(".");
    const config = upgradeOp("upgrade", ".");
    const first = await runOpLocally(config, ACTIVITIES, PROFILES, undefined, { cwd: root, ledger: { cwd: root } });

    expect(first.status).toBe("gated");
    expect(first.gate).toMatchObject({ op: "workspace-upgrade", gate: ".", timestamp: since });
    expect(first.records.map((r) => [r.fn, r.status])).toEqual([["workLease:claim", "ok"], ["shellCmd", "skipped"], ["shellCmd", "skipped"]]);
    expect(first.records[1].gate).toEqual({ op: "workspace-upgrade", gate: "." });
    expect(first.workLease).toMatchObject({ item: "workspace-upgrade", released: true, outcome: "gated" });

    const newest = (await readRunLedger("local", "upgrade", { cwd: root })).records.at(-1)!;
    expect(newest).toMatchObject({ status: "gated", gate: { name: ".", since, op: "workspace-upgrade" } });
    expect(newest.phases[0].steps[1]).toMatchObject({ fn: "shellCmd", status: "skipped", gate: { op: "workspace-upgrade", gate: "." } });
    expect((await readLeaseHistory("workspace-upgrade", { cwd: root })).records.at(-1)).toMatchObject({ event: "release", outcome: "gated" });

    // workspace status shows the gate the Op's run waits on, with the command that approves it.
    const steward = declareSteward({ name: "box-steward", ops: [config] });
    mkdirSync(join(root, "ops"), { recursive: true });
    writeFileSync(join(root, "ops", "steward.op.ts"), `export const steward = ${JSON.stringify(steward)};\n`);
    const status = await readMemberStewards(root, "local", new Date().toISOString());
    expect(status.reasons).toEqual([]);
    const entry = status.stewards.find((s) => s.name === "box-steward")!;
    contract({ $schema: statusSchema.$schema, $id: "urn:test:status-steward-gate", $defs: statusSchema.$defs, $ref: "#/$defs/steward" }).expectValid(entry);
    expect(entry.ops[0].lastRun).toMatchObject({
      status: "gated",
      gate: { name: ".", since, op: "workspace-upgrade", approve: "chant approve workspace-upgrade ." },
    });

    // `chant approve workspace-upgrade .`, and the next run applies the patch in the worktree.
    await approve(".");
    const second = await runOpLocally(config, ACTIVITIES, PROFILES, undefined, { cwd: root, ledger: { cwd: root } });
    expect(second.status).toBe("ok");
    expect(second.records.map((r) => [r.fn, r.status])).toEqual([["workLease:claim", "ok"], ["shellCmd", "ok"], ["shellCmd", "ok"]]);
    expect(second.workLease).toMatchObject({ released: true, outcome: "done" });
    expect(git(root, "show", `${second.workLease!.branch}:upgraded-..txt`)).toBe("upgraded");
    expect(existsSync(join(root, "upgraded-..txt"))).toBe(false);
    const status2 = await readMemberStewards(root, "local", new Date().toISOString());
    expect(status2.stewards[0].ops[0].lastRun).toMatchObject({ status: "ok", gate: null });
  });

  test("a local steward leaves its gated run while the gate stands, and runs it again once a person approves", async () => {
    await stage("web");
    const config = upgradeOp("upgrade-web", "web", { schedule: { cron: "0 0 1 1 *" } });
    const steward = declareSteward({ name: "web-steward", ops: [config] });
    const scheduleState = new Map<string, Date>();
    const round = (minute: number) =>
      runOperatorRound({ cwd: root, steward, activities: ACTIVITIES, profiles: PROFILES, holder: "box", now: () => new Date(2027, 0, 1, 0, minute, 10), scheduleState });

    const first = await round(0);
    expect(first[0]).toMatchObject({ kind: "ticked", op: "upgrade-web" });
    expect((first[0] as { result: { status: string } }).result.status).toBe("gated");
    expect(formatRoundLine(first[0])).toContain('status=gated gate="web"');
    expect((await readRunLedger("local", "upgrade-web", { cwd: root })).records.at(-1)).toMatchObject({ status: "gated", steward: "web-steward" });

    const second = await round(5);
    expect(second).toEqual([{ kind: "waiting-on-gate", op: "upgrade-web", env: "local", gateOp: "workspace-upgrade", gate: "web" }]);
    expect(formatRoundLine(second[0])).toBe("operator: upgrade-web@local gated=1(gate:workspace-upgrade/web)");

    await approve("web");
    const third = await round(10);
    expect(third[0]).toMatchObject({ kind: "ticked", op: "upgrade-web", approved: { op: "workspace-upgrade", gate: "web" } });
    expect((third[0] as { result: { status: string } }).result.status).toBe("ok");
    expect(formatRoundLine(third[0])).toContain('approved="workspace-upgrade/web"');

    // Done: the next round waits for the cron again.
    expect(await round(15)).toEqual([{ kind: "skipped-not-due", op: "upgrade-web", env: "local", cron: "0 0 1 1 *" }]);
  });
});
