/**
 * #4762: the engine-neutral lock release on an in-memory lock and ledger,
 * and the forge clients' live runs through a recording fetch. No forge, no
 * store and no git are reached.
 */
import { describe, expect, test } from "vitest";
import { fakeLedger } from "./__fixtures__/gated-ledger";
import type { ForgeFetch } from "./pr-forge";
import { CLOCK_SKEW_MS, forgeLiveRuns, parseLockInfo, possibleHolders, releaseStateLock, STATE_UNLOCK_FLOOR, StateUnlockError, type LiveRun, type LockInfo, type StateLockSource } from "./state-unlock";

const LOCK: LockInfo = { ID: "a1b2", Operation: "OperationTypeApply", Who: "runner@ci", Created: "2026-11-08T08:00:00Z" };

function lock(held: LockInfo | undefined, stuck = false): StateLockSource & { released: string[] } {
  let now = held;
  const released: string[] = [];
  return {
    location: "s3://states/net.tfstate.tflock",
    released,
    read: async () => now,
    release: async (id) => {
      released.push(id);
      if (!stuck && now?.ID === id) now = undefined;
    },
  };
}

const run = (id: string, started: string): LiveRun => ({ id, status: "in_progress", started });

const base = (ledger: ReturnType<typeof fakeLedger>, l: StateLockSource, runs: () => Promise<LiveRun[]>, extra: Record<string, unknown> = {}) => ({
  subject: "net",
  by: "ana",
  lock: l,
  liveRuns: runs,
  words: { op: "tf-unlock", approveCommand: (s: string, d: string) => `product approve unlock ${s} --plan ${d}` },
  rules: { mode: "ledger" as const },
  ledger,
  now: "2026-11-08T09:00:00Z",
  ...extra,
});

describe("releaseStateLock", () => {
  test("a free lock asks nothing", async () => {
    const ledger = fakeLedger();
    expect(await releaseStateLock(base(ledger, lock(undefined), async () => []))).toEqual({ status: "free", exit: 0, location: "s3://states/net.tfstate.tflock" });
    expect(ledger.writes).toEqual([]);
  });

  test("a run that began before the lock keeps it held, and nothing is asked", async () => {
    const ledger = fakeLedger();
    const l = lock(LOCK);
    const r = await releaseStateLock(base(ledger, l, async () => [run("7", "2026-11-08T07:59:00Z"), run("8", "2026-11-08T08:30:00Z")]));
    expect(r).toMatchObject({ status: "alive", exit: 5 });
    expect(r.status === "alive" && r.alive.map((x) => x.id)).toEqual(["7"]);
    expect(ledger.writes).toEqual([]);
    expect(l.released).toEqual([]);
  });

  test("waits for an approval of that lock, then releases it by its ID and records who released it", async () => {
    const ledger = fakeLedger();
    const l = lock(LOCK);
    const first = await releaseStateLock(base(ledger, l, async () => [run("8", "2026-11-08T08:30:00Z")]));
    expect(first).toMatchObject({ status: "waiting", exit: 3 });
    expect(first.status === "waiting" && first.command).toBe(`product approve unlock net --plan ${first.status === "waiting" ? first.digest : ""}`);
    ledger.approve("bo");
    const second = await releaseStateLock(base(ledger, l, async () => [], { now: "2026-11-08T12:00:00Z" }));
    expect(second).toMatchObject({ status: "released", exit: 0, approvedBy: "bo", digest: first.status === "waiting" ? first.digest : "" });
    expect(l.released).toEqual(["a1b2"]);
    expect(ledger.writes).toEqual(["pending", "applied", "finished:applied"]);
    expect(ledger.details[0]).toMatchObject({ by: "ana", lock_id: "a1b2", locked_by: "runner@ci", approved_by: "bo", live_runs: 0, location: "s3://states/net.tfstate.tflock" });
  });

  test("a run that came back after the approval holds the release, and the approval stays unspent", async () => {
    const ledger = fakeLedger();
    ledger.approve("bo");
    let calls = 0;
    const runs = async () => (++calls === 1 ? [] : [run("9", "2026-11-08T07:00:00Z")]);
    const l = lock(LOCK);
    const r = await releaseStateLock(base(ledger, l, runs));
    expect(r).toMatchObject({ status: "held", exit: 5 });
    expect(r.status === "held" && r.reason).toMatch(/alive again \(run 9 /);
    expect(ledger.writes).toEqual(["pending"]);
    expect(l.released).toEqual([]);
  });

  test("a release that leaves the lock held fails the request", async () => {
    const ledger = fakeLedger();
    ledger.approve("bo");
    const r = await releaseStateLock(base(ledger, lock(LOCK, true), async () => []));
    expect(r).toMatchObject({ status: "failed", exit: 1 });
    expect(r.status === "failed" && r.error.message).toMatch(/still holds it/);
    expect(ledger.writes.at(-1)).toBe("finished:failed");
  });

  test("runs that cannot be read refuse the release", async () => {
    const ledger = fakeLedger();
    await expect(releaseStateLock(base(ledger, lock(LOCK), async () => Promise.reject(new Error("401"))))).rejects.toBeInstanceOf(StateUnlockError);
    expect(ledger.writes).toEqual([]);
  });

  test("possibleHolders keeps a run within the clocks' skew, and every run for a lock with no time", () => {
    const runs = [run("a", "2026-11-08T08:01:00Z"), run("b", "2026-11-08T08:03:00Z"), { id: "c", status: "queued" }];
    expect(possibleHolders(runs, "2026-11-08T08:00:00Z").map((r) => r.id)).toEqual(["a", "c"]);
    expect(possibleHolders(runs, undefined).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(CLOCK_SKEW_MS).toBe(120_000);
    expect(parseLockInfo('{"ID":"x","Who":"me","Extra":1}')).toEqual({ ID: "x", Who: "me" });
    expect(parseLockInfo('{"Who":"me"}')).toBeUndefined();
  });

  test("its floor is the next release", () => {
    expect(STATE_UNLOCK_FLOOR).toBe("0.124.77");
  });
});

/** A forge answering `routes` by `METHOD path?query`, recording the calls. */
function forgeFetch(routes: Record<string, unknown>): { fetch: ForgeFetch; urls: string[]; headers: Array<Record<string, string>> } {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetch: ForgeFetch = async (url, init) => {
    urls.push(url);
    headers.push(init.headers);
    const u = new URL(url);
    const found = routes[`${init.method} ${u.pathname}${u.search}`];
    return found === undefined ? { ok: true, status: 200, text: async () => "[]" } : { ok: true, status: 200, text: async () => JSON.stringify(found) };
  };
  return { fetch, urls, headers };
}

describe("forgeLiveRuns", () => {
  test("GitHub: queued, waiting and running runs, once each, with when each began", async () => {
    const { fetch, urls, headers } = forgeFetch({
      "GET /repos/acme/infra/actions/runs?status=in_progress&per_page=100": { workflow_runs: [{ id: 1, status: "in_progress", run_started_at: "2026-11-08T08:00:00Z", html_url: "https://github.com/acme/infra/actions/runs/1" }] },
      "GET /repos/acme/infra/actions/runs?status=queued&per_page=100": { workflow_runs: [{ id: 2, status: "queued", created_at: "2026-11-08T08:05:00Z" }, { id: 1, status: "in_progress", run_started_at: "2026-11-08T08:00:00Z" }] },
    });
    const runs = await forgeLiveRuns({ kind: "github", apiBase: "https://api.github.com", repo: "acme/infra", token: "t", fetch });
    expect(runs).toEqual([
      { id: "1", status: "in_progress", started: "2026-11-08T08:00:00Z" },
      { id: "2", status: "queued", started: "2026-11-08T08:05:00Z" },
    ]);
    expect(urls).toHaveLength(5);
    expect(headers[0]!.Authorization).toBe("Bearer t");
  });

  test("Forgejo: a run whose start is the epoch counts from its creation", async () => {
    const { fetch } = forgeFetch({
      "GET /api/v1/repos/acme/infra/actions/runs?status=waiting&limit=50": { workflow_runs: [{ id: 5, status: "waiting", started: "1970-01-01T00:00:00Z", created: "2026-11-08T08:10:00Z" }] },
    });
    const runs = await forgeLiveRuns({ kind: "forgejo", apiBase: "https://codeberg.org/api/v1", repo: "acme/infra", token: "t", fetch });
    expect(runs).toEqual([{ id: "5", status: "waiting", started: "2026-11-08T08:10:00Z" }]);
  });

  test("a forge that answers an error throws, so the release is refused", async () => {
    const fetch: ForgeFetch = async () => ({ ok: false, status: 401, text: async () => '{"message":"401 Unauthorized"}' });
    await expect(forgeLiveRuns({ kind: "github", apiBase: "https://api.github.com", repo: "acme/infra", fetch })).rejects.toThrow(/401/);
  });

  test("GitLab: running, pending, preparing and waiting pipelines", async () => {
    const { fetch, urls, headers } = forgeFetch({
      "GET /api/v4/projects/42/pipelines?status=pending&per_page=100": [{ id: 77, status: "pending", created_at: "2026-11-08T08:00:00Z", web_url: "https://gitlab.example.com/acme/infra/-/pipelines/77" }],
    });
    const runs = await forgeLiveRuns({ kind: "gitlab", apiBase: "https://gitlab.example.com/api/v4", repo: "42", token: "glpat", fetch });
    expect(runs).toEqual([{ id: "77", status: "pending", started: "2026-11-08T08:00:00Z", url: "https://gitlab.example.com/acme/infra/-/pipelines/77" }]);
    expect(urls.map((u) => new URL(u).searchParams.get("status"))).toEqual(["running", "pending", "preparing", "waiting_for_resource"]);
    expect(headers[0]!["PRIVATE-TOKEN"]).toBe("glpat");
  });
});
