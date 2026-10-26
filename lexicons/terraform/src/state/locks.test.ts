// The source-workspace lock a state migration takes (terragucci#1274): a workspace a state is read from is locked
// through its own API before any state lock, and released when a later lock cannot be taken.
import { describe, expect, it } from "vitest";
import { SourceLockedError, StateLockedError, takeLocksWithSources, takeSourceLocks, type LockStore, type SourceLock } from "./locks";

const T = "2026-10-25T00:00:00Z";
const op = { operation: "terragucci migrate", info: "a state migration is writing this state" };

function store(location: string, held?: string): LockStore & { taken: string[]; released: number } {
  const s = {
    location,
    lockLocation: `${location}.tflock`,
    taken: [] as string[],
    released: 0,
    heldLock: async () => (held ? { id: "other", info: held } : undefined),
    lock: async (info: string) => {
      if (held) return false;
      s.taken.push(info);
      return true;
    },
    unlock: async () => {
      s.released++;
    },
    adopt: () => {},
  };
  return s;
}

function source(root: string, location: string, refuse?: string): SourceLock & { reasons: string[]; released: number } {
  const s = {
    root,
    location,
    reasons: [] as string[],
    released: 0,
    lock: async (reason: string) => {
      if (refuse) throw new Error(refuse);
      s.reasons.push(reason);
      return async () => {
        s.released++;
      };
    },
  };
  return s;
}

describe("source-workspace locks", () => {
  it("takes the source workspaces first, naming what reads them, then the states", async () => {
    const src = source("envs/dev", "app.terraform.io/acme/dev");
    const st = store("s3://b/envs/dev.tfstate");
    const got = await takeLocksWithSources({ sources: [src], stores: [{ root: "envs/dev", store: st }], now: T, op, sourceOp: { operation: "terragucci migrate", info: "a state migration is reading this state" } });
    expect(src.reasons).toEqual(["terragucci migrate: a state migration is reading this state"]);
    expect(st.taken).toHaveLength(1);
    expect(JSON.parse(st.taken[0]!)).toMatchObject({ Operation: "terragucci migrate", Created: T, Path: "b/envs/dev.tfstate" });
    expect(got.sources.map((s) => s.root)).toEqual(["envs/dev"]);
    expect(got.locks.map((l) => l.root)).toEqual(["envs/dev"]);
    await got.sources[0]!.release();
    expect(src.released).toBe(1);
  });

  it("names the operation's own info on a source lock without sourceOp", async () => {
    const src = source("a", "ws");
    await takeSourceLocks([src], op);
    expect(src.reasons).toEqual(["terragucci migrate: a state migration is writing this state"]);
  });

  it("releases the source locks when a state is locked by another run", async () => {
    const src = source("envs/dev", "ws");
    const st = store("s3://b/k", JSON.stringify({ ID: "x", Operation: "OperationTypeApply", Who: "someone" }));
    await expect(takeLocksWithSources({ sources: [src], stores: [{ root: "envs/dev", store: st }], now: T, op })).rejects.toBeInstanceOf(StateLockedError);
    expect(src.released).toBe(1);
  });

  it("releases what it took and takes no state lock when a source workspace is locked", async () => {
    const first = source("a", "ws-a");
    const second = source("b", "ws-b", "its workspace ws-b is locked");
    const st = store("s3://b/k");
    const err = await takeLocksWithSources({ sources: [first, second], stores: [{ root: "a", store: st }], now: T, op }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SourceLockedError);
    expect((err as SourceLockedError).root).toBe("b");
    expect((err as Error).message).toContain("ws-b is locked");
    expect(first.released).toBe(1);
    expect(st.taken).toEqual([]);
  });
});
