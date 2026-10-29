/**
 * Op waves under the ruling for ci-products (2026-10-28), "Ledger lock",
 * and plywood#22 finding 9, on a bare remote with one clone per writer:
 *
 * - a run on the `target` grain whose lexicon names its target's row waits
 *   for it on the ledger, then applies; at the deadline it applies nothing,
 *   held, exit 5, by name;
 * - a run on the resource grain never waits: a held row is exit 5 at once;
 * - a run whose plan changes nothing takes no row;
 * - the job's run record lands when another writer pushed to the same
 *   ledger file first.
 */
import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpWavesSpec } from "./op-waves";
import { gitOpWaveRunPort, runOpWave, type OpWaveShowAtBase } from "./op-waves-run";
import { memoryGateLedgerPort } from "./gate";
import { CapabilityRegistry, type Capability } from "../components/capability";
import type { ChangeSetPart } from "../change-set";
import { rootRowKey, type LockGrain } from "../lifecycle/lock-rows";
import { leaseLockRows, readLockRows } from "../lifecycle/resource-lock";
import { appendRunRecord, readRunLedger } from "../lifecycle/run-ledger";
import { pushLifecycle } from "../lifecycle/git";
import { CHANT_EXIT } from "../exit-codes";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writers(n: number): string[] {
  const remote = tmp("op-waves-lock-remote-");
  git(remote, "init", "-q", "--bare", "-b", "main");
  const seed = tmp("op-waves-lock-seed-");
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.email", "seed@chant.dev");
  git(seed, "config", "user.name", "Seed");
  git(seed, "config", "commit.gpgsign", "false");
  writeFileSync(join(seed, "README.md"), "# t\n");
  git(seed, "add", "README.md");
  git(seed, "commit", "-q", "-m", "init");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-q", "origin", "main");
  return Array.from({ length: n }, (_, i) => {
    const c = tmp(`op-waves-lock-clone-${i}-`);
    git(c, "clone", "-q", remote, ".");
    git(c, "config", "user.email", `w${i}@chant.dev`);
    git(c, "config", "user.name", `Writer ${i}`);
    git(c, "config", "commit.gpgsign", "false");
    return c;
  });
}

const digest = (n: string) => `sha256:${n.repeat(64)}`;
const alive = async () => "alive" as const;

/** A root capability on `grain`: the target grain names `root <root>`, the resource grain one row per root. */
function rootCapability(grain: LockGrain, action: "create" | "no-op" = "create"): { registry: CapabilityRegistry; ran: string[] } {
  const ran: string[] = [];
  const part = (member: string): ChangeSetPart => ({
    member: { member, lexicon: "terraform", planner: "chant", status: "planned", planDigest: digest("9"), holes: [] },
    entries: [{ member, address: `aws_s3_bucket.${member}`, type: "aws_s3_bucket", action } as ChangeSetPart["entries"][number]],
  });
  const cap: Capability<Record<string, unknown>, unknown> = {
    kind: "fake-root",
    async plan(_ctx, input) {
      const root = String(input.root);
      return { member: root, planDigest: digest(root === "network" ? "1" : "2"), artifact: { root }, changeSet: part(root) };
    },
    async run(_ctx, input) {
      ran.push(String(input.root));
      return { applied: input.root };
    },
    defaultLockGrain: () => grain,
    targetLockRow: (input) => ({ key: rootRowKey(String(input.root)), target: String(input.root), address: String(input.root) }),
    lockRows: (input) => [{ key: `root ${String(input.root)} aws_s3_bucket.${String(input.root)}`, target: String(input.root), address: `aws_s3_bucket.${String(input.root)}` }],
  };
  return { registry: new CapabilityRegistry().register(cap), ran };
}

const spec: OpWavesSpec = {
  name: "roots",
  op: "tf-apply",
  step: { kind: "fake-root", root: "{target}" },
  waves: [{ name: "dev", runs: [{ target: "network" }], gate: "never" }],
};
const show: OpWaveShowAtBase = () => ({ sha: "b".repeat(40), text: JSON.stringify(spec) });

describe("op waves and the ledger lock", () => {
  test("a root on the target grain waits for its root row, then applies once the other run lets go", async () => {
    const [other, job] = writers(2) as [string, string];
    const held = await leaseLockRows("pr-apply", [{ key: rootRowKey("network"), target: "network", address: "network" }], { cwd: other, alive, holder: { run: "71", at: new Date().toISOString() } });
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    const { registry, ran } = rootCapability("target");
    const lines: string[] = [];
    const letGo = setTimeout(() => void held.lease.release(), 400);
    try {
      const result = await runOpWave({
        spec,
        specFile: "waves.json",
        wave: 1,
        cwd: job,
        show,
        gates: memoryGateLedgerPort(),
        capabilities: registry,
        lockLiveness: alive,
        lockPollMs: 50,
        lockWaitSeconds: 60,
        log: (l) => lines.push(l),
      });
      expect(result).toMatchObject({ exitCode: 0, applied: ["network"] });
    } finally {
      clearTimeout(letGo);
    }
    expect(ran).toEqual(["network"]);
    const text = lines.join("\n");
    expect(text).toContain("wave 1 (dev): waits for root network of pr-apply: run 71 is applying network: network");
    expect(text).toMatch(/wave 1 \(dev\): holds 1 row of pr-apply after waiting \d+s while it applies/);
    // The job let go of the row when the wave ended.
    expect((await readLockRows("pr-apply", { cwd: other })).rows).toEqual({});
  });

  test("a wait that reaches the job's deadline applies nothing, held, exit 5, by name", async () => {
    const [other, job] = writers(2) as [string, string];
    const held = await leaseLockRows("pr-apply", [{ key: rootRowKey("network"), target: "network", address: "network" }], { cwd: other, alive, holder: { run: "72", at: new Date().toISOString() } });
    expect(held.ok).toBe(true);
    const { registry, ran } = rootCapability("target");
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: job, show, gates: memoryGateLedgerPort(), capabilities: registry, lockLiveness: alive, lockPollMs: 10, lockWaitSeconds: 0, log: () => {} });
    expect(result.exitCode).toBe(CHANT_EXIT.held);
    expect(result.outcome).toMatchObject({ outcome: "held", holder: { run: "72" } });
    expect(result.outcome!.reason).toMatch(/^LockWaitTimeoutError: waited \d+s for root network of pr-apply/);
    expect(ran).toEqual([]);
    expect((await readLockRows("pr-apply", { cwd: other })).waiting).toBeUndefined();
  });

  test("a run on the resource grain never waits: a held row is exit 5 at once", async () => {
    const [other, job] = writers(2) as [string, string];
    const key = "root network aws_s3_bucket.network";
    const held = await leaseLockRows("pr-apply", [{ key, target: "network", address: "aws_s3_bucket.network" }], { cwd: other, alive, holder: { run: "73", at: new Date().toISOString() } });
    expect(held.ok).toBe(true);
    const { registry, ran } = rootCapability("resource");
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: job, show, gates: memoryGateLedgerPort(), capabilities: registry, lockLiveness: alive, lockPollMs: 10, lockWaitSeconds: 60, log: () => {} });
    expect(result.exitCode).toBe(CHANT_EXIT.held);
    expect(result.outcome!.reason).not.toContain("LockWaitTimeoutError");
    expect(ran).toEqual([]);
  });

  test("a run whose plan changes nothing takes no row and applies beside the holder", async () => {
    const [other, job] = writers(2) as [string, string];
    const held = await leaseLockRows("pr-apply", [{ key: rootRowKey("network"), target: "network", address: "network" }], { cwd: other, alive, holder: { run: "74", at: new Date().toISOString() } });
    expect(held.ok).toBe(true);
    const { registry } = rootCapability("target", "no-op");
    const result = await runOpWave({ spec, specFile: "waves.json", wave: 1, cwd: job, show, gates: memoryGateLedgerPort(), capabilities: registry, lockLiveness: alive, lockPollMs: 10, lockWaitSeconds: 0, log: () => {} });
    expect(result.exitCode).toBe(0);
  });
});

describe("plywood#22 finding 9: the waves run's run record", () => {
  test("lands on the remote when another writer appended to the same run ledger first", async () => {
    const [a, b] = writers(2) as [string, string];
    const record = (ended: string) => ({
      op: "pulumi-up",
      env: "dev",
      started: "2026-10-28T23:39:08.000Z",
      ended,
      status: "ok" as const,
      labels: { Env: "dev" },
      outcomes: {},
      phases: [],
    });
    // B's job wrote nothing yet; A, the other push's job, appends to dev/pulumi-up's ledger and pushes first.
    await appendRunRecord(record("2026-10-28T23:40:03.000Z"), { cwd: a });
    expect(await pushLifecycle({ cwd: a })).toBe(true);
    git(b, "fetch", "-q", "origin", "chant/lifecycle:chant/lifecycle");
    await appendRunRecord(record("2026-10-28T23:40:30.000Z"), { cwd: a });
    expect(await pushLifecycle({ cwd: a })).toBe(true);
    // B appends on the copy it fetched before A's second push, and its push replays on A's tip.
    const port = gitOpWaveRunPort({ cwd: b });
    expect(await port.append(record("2026-10-28T23:41:17.000Z"))).toEqual({});
    git(a, "fetch", "-q", "origin", "chant/lifecycle:chant/lifecycle");
    const { records } = await readRunLedger("dev", "pulumi-up", { cwd: a });
    expect(records.map((r) => r.ended)).toEqual(["2026-10-28T23:40:03.000Z", "2026-10-28T23:40:30.000Z", "2026-10-28T23:41:17.000Z"]);
  });
});
