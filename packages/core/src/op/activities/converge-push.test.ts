import { describe, test, expect, vi, beforeEach } from "vitest";

/**
 * chant#2337 — a converge tick says whether its record reached the remote.
 *
 * `convergeTick` ended with `await pushLifecycle().catch(() => undefined)`, the
 * last instance of the idiom #2310 was filed about. The append is local-first
 * and always lands, so the tick's own result was correct either way — what was
 * missing is whether anyone else can see it.
 *
 * Softer than the gate's version of the same bug, which #2336 fixed: a lost
 * tick record is an informational log rather than an approval, so nobody is
 * left waiting on a fact they cannot see. It is still not success, and a
 * converge loop reporting a clean tick while its ledger never leaves the
 * machine is telling an operator something untrue.
 */
const execMock = vi.fn();
vi.mock("node:child_process", () => ({
  exec: (cmd: string, _opts: unknown, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) =>
    cb(null, { stdout: execMock(cmd) as string, stderr: "" }),
}));

const pushLifecycle = vi.fn();
vi.mock("../../lifecycle/git", () => ({
  fetchLifecycle: vi.fn(async () => undefined),
  pushLifecycle: (...args: unknown[]) => pushLifecycle(...args) as Promise<boolean>,
}));

vi.mock("../../lifecycle/converge-ledger", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    readConvergeLedger: vi.fn(async () => ({ records: [] })),
    appendConvergeRecord: vi.fn(async (record: Record<string, unknown>) => ({
      record: { ...record, id: "tick-1" },
    })),
  };
});

const { convergeTick } = await import("./converge");

/** A tick with nothing to do: no drift, no rules, so only the ledger write matters. */
async function tick(): Promise<Awaited<ReturnType<typeof convergeTick>>> {
  return convergeTick({ opName: "demo", env: "prod", rules: [], dial: "report" } as never);
}

describe("a converge tick reports its push outcome (chant#2337)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execMock.mockImplementation((cmd: string) =>
      cmd.includes("lifecycle plan")
        ? JSON.stringify({ env: "prod", entries: [] })
        : JSON.stringify([]),
    );
  });

  test("a push that lands reports pushed, with no warning", async () => {
    pushLifecycle.mockResolvedValue(true);

    const result = await tick();

    expect(result.pushed).toBe(true);
    expect(result.pushWarning).toBeUndefined();
  });

  test("a REJECTED push is reported, not swallowed", async () => {
    // Red before chant#2337: `.catch(() => undefined)` meant the tick returned
    // the same shape whether or not the record left the machine.
    pushLifecycle.mockRejectedValue(new Error("remote rejected: chant/lifecycle has moved"));

    const result = await tick();

    expect(result.pushed).toBe(false);
    expect(result.pushWarning).toContain("remote rejected");
  });

  test("no remote configured is reported too, and says which it is", async () => {
    // `pushLifecycle` returns false rather than throwing when there is no
    // remote. That is not an error, but it is not a push either, and the two
    // reasons are worth telling apart in the warning.
    pushLifecycle.mockResolvedValue(false);

    const result = await tick();

    expect(result.pushed).toBe(false);
    expect(result.pushWarning).toMatch(/no remote/i);
  });

  test("the tick's own findings are unaffected by a failed push", async () => {
    // The append is local-first and always lands. A push failure must not make
    // the tick misreport what it observed, or the fix would have traded one
    // wrong answer for another.
    pushLifecycle.mockRejectedValue(new Error("nope"));

    const result = await tick();

    expect(result.id).toBe("tick-1");
    expect(result.drifted).toBe(false);
    expect(typeof result.log).toBe("string");
  });
});
