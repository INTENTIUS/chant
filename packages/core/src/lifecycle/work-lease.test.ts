/**
 * #2732 — the work lease: the operator lease under `work/<id>`, with a
 * `_leases/<id>.jsonl` history, coordinating workers in one clone and across
 * clones through a bare remote.
 */
import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimWorkLease,
  listWorkLeases,
  readLeaseHistory,
  releaseWorkLease,
  renewWorkLease,
  workLeaseRef,
  leaseHistoryPath,
} from "./work-lease";
import { readRefSha } from "./git";

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

function configure(dir: string): void {
  git(dir, "config", "user.email", "test@chant.dev");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "commit.gpgsign", "false");
}

function initRepo(): string {
  const dir = tmp("chant-work-lease-");
  git(dir, "init", "-q", "-b", "main");
  configure(dir);
  writeFileSync(join(dir, "README.md"), "# t\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const at = (iso: string) => () => new Date(iso);

describe("a work lease in one clone", () => {
  test("a claim takes a free item, and a second claim is refused with the holder named, the same holder's included", async () => {
    const cwd = initRepo();
    const first = await claimWorkLease("W-001", "alice", { cwd, ttlMs: 60_000 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.lease).toMatchObject({ item: "W-001", holder: "alice" });
    expect(await readRefSha(workLeaseRef("W-001"), { cwd })).not.toBeNull();

    const second = await claimWorkLease("W-001", "bob", { cwd });
    expect(second).toMatchObject({ ok: false, reason: "lease-held", heldBy: { holder: "alice", token: first.lease.token } });
    if (!second.ok) expect(second.message).toContain("alice");

    const again = await claimWorkLease("W-001", "alice", { cwd });
    expect(again).toMatchObject({ ok: false, reason: "lease-held" });
  });

  test("a renew moves the expiry and keeps the token; an expired lease can be claimed, with a new token", async () => {
    const cwd = initRepo();
    const claim = await claimWorkLease("W-002", "alice", { cwd, ttlMs: 60_000, now: at("2026-09-25T10:00:00.000Z") });
    if (!claim.ok) throw new Error(claim.message);
    expect(claim.lease.expiresAt).toBe("2026-09-25T10:01:00.000Z");

    const renew = await renewWorkLease("W-002", "alice", { cwd, ttlMs: 60_000, token: claim.lease.token, now: at("2026-09-25T10:00:30.000Z") });
    if (!renew.ok) throw new Error(renew.message);
    expect(renew.lease.token).toBe(claim.lease.token);
    expect(renew.lease.acquiredAt).toBe(claim.lease.acquiredAt);
    expect(renew.lease.expiresAt).toBe("2026-09-25T10:01:30.000Z");

    // Another holder can't renew it, and a stale token is refused.
    expect(await renewWorkLease("W-002", "bob", { cwd, now: at("2026-09-25T10:00:40.000Z") })).toMatchObject({ ok: false, reason: "lease-held" });
    expect(await renewWorkLease("W-002", "alice", { cwd, token: "stale", now: at("2026-09-25T10:00:40.000Z") })).toMatchObject({ ok: false, reason: "lease-token-mismatch" });

    // Past its expiry: renew is refused, and a claim by anyone mints a new token.
    const late = at("2026-09-25T10:02:00.000Z");
    expect(await renewWorkLease("W-002", "alice", { cwd, now: late })).toMatchObject({ ok: false, reason: "lease-not-held" });
    const reclaim = await claimWorkLease("W-002", "bob", { cwd, ttlMs: 60_000, now: late });
    if (!reclaim.ok) throw new Error(reclaim.message);
    expect(reclaim.lease.holder).toBe("bob");
    expect(reclaim.lease.token).not.toBe(claim.lease.token);
  });

  test("release: the holder gives a live lease back; someone else can't, but anyone closes out an expired one", async () => {
    const cwd = initRepo();
    const t0 = "2026-09-25T10:00:00.000Z";
    const claim = await claimWorkLease("W-003", "alice", { cwd, ttlMs: 60_000, now: at(t0) });
    if (!claim.ok) throw new Error(claim.message);
    expect(await releaseWorkLease("W-003", "bob", { cwd, now: at(t0) })).toMatchObject({ ok: false, reason: "lease-held", heldBy: { holder: "alice" } });
    const released = await releaseWorkLease("W-003", "alice", { cwd, outcome: "done", now: at(t0) });
    expect(released.ok).toBe(true);
    expect(await readRefSha(workLeaseRef("W-003"), { cwd })).toBeNull();
    expect(await releaseWorkLease("W-003", "alice", { cwd })).toMatchObject({ ok: false, reason: "lease-not-held" });

    const again = await claimWorkLease("W-003", "carol", { cwd, ttlMs: 1_000, now: at(t0) });
    if (!again.ok) throw new Error(again.message);
    const closed = await releaseWorkLease("W-003", "dispatcher", { cwd, outcome: "expired", now: at("2026-09-25T11:00:00.000Z") });
    expect(closed).toMatchObject({ ok: true, lease: { holder: "carol" } });
  });

  test("the history has one line per claim, renew and release, on chant/lifecycle", async () => {
    const cwd = initRepo();
    const claim = await claimWorkLease("W-004", "alice", { cwd, note: "starting" });
    if (!claim.ok) throw new Error(claim.message);
    expect(claim.history.path).toBe(leaseHistoryPath("W-004"));
    expect(claim.history.pushed).toBe(false);
    await renewWorkLease("W-004", "alice", { cwd });
    await renewWorkLease("W-004", "alice", { cwd });
    await releaseWorkLease("W-004", "alice", { cwd, outcome: "done" });

    const { records, malformed } = await readLeaseHistory("W-004", { cwd });
    expect(malformed).toBe(0);
    expect(records.map((r) => r.event)).toEqual(["claim", "renew", "renew", "release"]);
    expect(new Set(records.map((r) => r.token)).size).toBe(1);
    expect(records[0]).toMatchObject({ version: 1, item: "W-004", holder: "alice", by: "alice", note: "starting" });
    expect(records[3]).toMatchObject({ outcome: "done" });
    expect(git(cwd, "show", `chant/lifecycle:_leases/W-004.jsonl`).split("\n")).toHaveLength(4);
  });

  test("listWorkLeases reports active and expired leases and leaves released ones out", async () => {
    const cwd = initRepo();
    const t0 = "2026-09-25T10:00:00.000Z";
    await claimWorkLease("W-010", "alice", { cwd, ttlMs: 60_000, now: at(t0) });
    await claimWorkLease("W-011", "bob", { cwd, ttlMs: 1_000, now: at(t0) });
    await claimWorkLease("W-012", "carol", { cwd, ttlMs: 60_000, now: at(t0) });
    await releaseWorkLease("W-012", "carol", { cwd, now: at(t0) });
    const leases = await listWorkLeases({ cwd, memberPrefix: "", now: new Date("2026-09-25T10:00:30.000Z") });
    expect(leases.map((l) => [l.item, l.holder, l.state])).toEqual([
      ["W-010", "alice", "active"],
      ["W-011", "bob", "expired"],
    ]);
    expect(leases[0].ref).toBe("refs/chant/lease/work/W-010");
  });

  test("an id that can't be one ref segment is refused", async () => {
    const cwd = initRepo();
    await expect(claimWorkLease("../x", "alice", { cwd })).rejects.toThrow(/can't key a work lease/);
    await expect(claimWorkLease("a/b", "alice", { cwd })).rejects.toThrow(/can't key a work lease/);
  });

  test("a workspace member's leases and history sit under _members/<member>/ (D7)", async () => {
    const cwd = initRepo();
    writeFileSync(join(cwd, "chant.workspace.json"), JSON.stringify({ name: "acme", schema: 1, members: [{ name: "api", dir: "api", kind: "other", because: "t" }] }));
    execFileSync("mkdir", ["-p", join(cwd, "api")]);
    const member = join(cwd, "api");
    const claim = await claimWorkLease("W-020", "alice", { cwd: member });
    if (!claim.ok) throw new Error(claim.message);
    expect(await readRefSha("refs/chant/lease/_members/api/work/W-020", { cwd })).not.toBeNull();
    expect(await readRefSha("refs/chant/lease/work/W-020", { cwd })).toBeNull();
    expect(claim.history.path).toBe("_members/api/_leases/W-020.jsonl");
    expect(git(cwd, "show", "chant/lifecycle:_members/api/_leases/W-020.jsonl")).toContain('"event":"claim"');
    expect((await listWorkLeases({ cwd, memberPrefix: "_members/api/" })).map((l) => l.item)).toEqual(["W-020"]);
    expect(await listWorkLeases({ cwd, memberPrefix: "" })).toEqual([]);
  });
});

describe("a work lease across clones, through a bare remote", () => {
  function setup(): { remote: string; a: string; b: string } {
    const root = tmp("chant-work-lease-remote-");
    const remote = join(root, "remote.git");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    const a = join(root, "a");
    git(root, "clone", "-q", remote, a);
    configure(a);
    writeFileSync(join(a, "README.md"), "# t\n");
    git(a, "add", "README.md");
    git(a, "commit", "-q", "-m", "init");
    git(a, "push", "-q", "origin", "main");
    const b = join(root, "b");
    git(root, "clone", "-q", remote, b);
    configure(b);
    return { remote, a, b };
  }

  test("A claims; B is refused with A named; A renews and releases on the remote; then B claims and A is refused", async () => {
    const { remote, a, b } = setup();
    const claim = await claimWorkLease("W-001", "worker-a", { cwd: a, ttlMs: 60_000 });
    if (!claim.ok) throw new Error(claim.message);
    expect(git(remote, "rev-parse", workLeaseRef("W-001"))).toBe(await readRefSha(workLeaseRef("W-001"), { cwd: a }));

    const refused = await claimWorkLease("W-001", "worker-b", { cwd: b });
    expect(refused).toMatchObject({ ok: false, reason: "lease-held", heldBy: { holder: "worker-a", token: claim.lease.token } });

    // A renew reaches the remote: the push expects the value A last pushed, not "absent".
    const renew = await renewWorkLease("W-001", "worker-a", { cwd: a, ttlMs: 120_000 });
    if (!renew.ok) throw new Error(renew.message);
    expect(git(remote, "rev-parse", workLeaseRef("W-001"))).toBe(await readRefSha(workLeaseRef("W-001"), { cwd: a }));
    const seen = await claimWorkLease("W-001", "worker-b", { cwd: b });
    expect(seen).toMatchObject({ ok: false, heldBy: { expiresAt: renew.lease.expiresAt } });
    // B's read-only listing now shows the remote's lease as last fetched.
    expect((await listWorkLeases({ cwd: b, memberPrefix: "" })).map((l) => l.holder)).toEqual(["worker-a"]);

    const released = await releaseWorkLease("W-001", "worker-a", { cwd: a, outcome: "done" });
    expect(released.ok).toBe(true);
    expect(() => git(remote, "rev-parse", "--verify", workLeaseRef("W-001"))).toThrow();

    const taken = await claimWorkLease("W-001", "worker-b", { cwd: b, ttlMs: 60_000 });
    if (!taken.ok) throw new Error(taken.message);
    expect(taken.lease.token).not.toBe(claim.lease.token);
    expect(await claimWorkLease("W-001", "worker-a", { cwd: a })).toMatchObject({ ok: false, reason: "lease-held", heldBy: { holder: "worker-b" } });

    // Both clones' histories reached the remote's chant/lifecycle.
    expect(claim.history.pushed).toBe(true);
    const lines = git(remote, "show", "chant/lifecycle:_leases/W-001.jsonl").split("\n").map((l) => JSON.parse(l).event);
    expect(lines).toEqual(["claim", "renew", "release", "claim"]);
  });

  test("a claim the remote refuses is undone locally: two clones can't both hold one item", async () => {
    const { remote, a, b } = setup();
    // B fetches from an empty remote, so it can't see A's claim, but pushes to the real one.
    const blind = join(tmp("chant-work-lease-blind-"), "blind.git");
    git(a, "init", "-q", "--bare", "-b", "main", blind);
    git(b, "remote", "set-url", "origin", blind);
    git(b, "remote", "set-url", "--push", "origin", remote);

    const claim = await claimWorkLease("W-005", "worker-a", { cwd: a });
    if (!claim.ok) throw new Error(claim.message);
    const lost = await claimWorkLease("W-005", "worker-b", { cwd: b });
    expect(lost).toMatchObject({ ok: false, reason: "lease-push-rejected" });
    expect(await readRefSha(workLeaseRef("W-005"), { cwd: b })).toBeNull();
    expect(git(remote, "rev-parse", workLeaseRef("W-005"))).toBe(await readRefSha(workLeaseRef("W-005"), { cwd: a }));
  });
});
