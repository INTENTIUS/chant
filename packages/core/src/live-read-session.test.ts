/**
 * The read session shares an identical read inside one scope and nowhere
 * else (chant #2498).
 */

import { describe, expect, it } from "vitest";
import { inLiveReadSession, liveReadKey, memoLiveRead, withLiveReadSession } from "./live-read-session";

function counter(): { read: () => Promise<number>; calls: number } {
  const state = { calls: 0, read: async () => ++state.calls };
  return state;
}

describe("memoLiveRead", () => {
  it("reads every time outside a session", async () => {
    const c = counter();
    expect(inLiveReadSession()).toBe(false);
    expect(await memoLiveRead("k", c.read)).toBe(1);
    expect(await memoLiveRead("k", c.read)).toBe(2);
    expect(c.calls).toBe(2);
  });

  it("reads once per key inside a session, including for callers that overlap in flight", async () => {
    const c = counter();
    await withLiveReadSession(async () => {
      expect(inLiveReadSession()).toBe(true);
      const [a, b] = await Promise.all([memoLiveRead("k", c.read), memoLiveRead("k", c.read)]);
      expect(a).toBe(1);
      expect(b).toBe(1);
      expect(await memoLiveRead("k", c.read)).toBe(1);
      expect(await memoLiveRead("other", c.read)).toBe(2);
    });
    expect(c.calls).toBe(2);
  });

  it("does not carry a read from one session into the next", async () => {
    const c = counter();
    await withLiveReadSession(() => memoLiveRead("k", c.read));
    await withLiveReadSession(() => memoLiveRead("k", c.read));
    expect(c.calls).toBe(2);
    expect(inLiveReadSession()).toBe(false);
  });

  it("joins an enclosing session rather than opening a nested one", async () => {
    const c = counter();
    await withLiveReadSession(async () => {
      await memoLiveRead("k", c.read);
      await withLiveReadSession(() => memoLiveRead("k", c.read));
    });
    expect(c.calls).toBe(1);
  });

  it("does not memoise a rejection", async () => {
    let attempts = 0;
    const read = async (): Promise<string> => {
      attempts++;
      if (attempts === 1) throw new Error("credentials");
      return "ok";
    };
    await withLiveReadSession(async () => {
      await expect(memoLiveRead("k", read)).rejects.toThrow("credentials");
      expect(await memoLiveRead("k", read)).toBe("ok");
      expect(await memoLiveRead("k", read)).toBe("ok");
    });
    expect(attempts).toBe(2);
  });
});

describe("liveReadKey", () => {
  it("is the same key whichever order the facts are given in, and differs on any fact", () => {
    expect(liveReadKey("live-plan", { root: "app", dir: "/x", adoptionOnly: false })).toBe(
      liveReadKey("live-plan", { adoptionOnly: false, dir: "/x", root: "app" }),
    );
    expect(liveReadKey("live-plan", { root: "app", dir: "/x" })).not.toBe(liveReadKey("live-ls", { root: "app", dir: "/x" }));
    expect(liveReadKey("live-plan", { root: "app", adoptionOnly: false })).not.toBe(
      liveReadKey("live-plan", { root: "app", adoptionOnly: true }),
    );
  });
});
