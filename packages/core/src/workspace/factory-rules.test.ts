/**
 * The factory's rules (#3406, ws-087): readiness, understand, retry, done
 * and the implements proposals, as pure functions. The Op that runs them is
 * tested in ../op/factory.e2e.test.ts.
 */

import { describe, expect, test } from "vitest";
import { isAsk, pickable, retryState, doneVerdict, proposeImplements, understandOutcome, type FactoryContext, type FactoryItem } from "./factory-rules";

describe("the factory's rules", () => {
  const base: FactoryItem = { id: "W-1", state: "open", openState: "open", proposedState: "proposed", ready: true, data: {}, tier: null, contract: null, warnings: [], answers: [], leased: false };
  const ctx: FactoryContext = { intentDecided: null, claims: [], attempts: { exhausted: false }, branch: null, questions: { tier: null, understand: null } };
  const hold = (i: Partial<FactoryItem>, c: Partial<FactoryContext> = {}) => {
    const v = pickable({ ...base, ...i }, { ...ctx, ...c });
    return v.ok ? "ok" : v.hold;
  };

  test("readiness", () => {
    expect(hold({})).toBe("ok");
    expect(hold({}, { intentDecided: false })).toBe("intent-undecided");
    expect(hold({ ready: false })).toBe("not-ready");
    expect(hold({ ready: false, state: "proposed", data: { source: { ask: { said: "x", by: "a" } } } })).toBe("ok");
    expect(hold({ contract: { id: "C-1", state: "draft" }, warnings: ["work-contract-undecided"] })).toBe("contract-not-approved");
    expect(hold({}, { branch: { state: "done", applied: false } })).toBe("built-not-applied");
    expect(hold({}, { branch: { state: "done", applied: true } })).toBe("ok");
    expect(hold({}, { branch: { state: "dropped", applied: false } })).toBe("dropped-on-branch");
    expect(hold({}, { attempts: { exhausted: true } })).toBe("attempts-exhausted");
    const failed = { claims: [{ token: "t1", ended: "released", outcome: "not_done", attempt: true }] };
    expect(hold({}, failed)).toBe("awaiting-retry");
    expect(hold({ data: { retry: { after: "t1", by: "alice" } } }, failed)).toBe("ok");
    expect(hold({ data: { retry: { after: "t0", by: "alice" } } }, failed)).toBe("awaiting-retry");
    expect(hold({}, { questions: { tier: { state: "escalated", answer: null }, understand: null } })).toBe("question-open");
    expect(hold({ tier: "large" }, { questions: { tier: { state: "escalated", answer: null }, understand: null } })).toBe("ok");
    const ask = { data: { source: { ask: { said: "x", by: "a" } } } };
    expect(hold(ask, { questions: { tier: null, understand: { state: "answered", answer: "redraft" } } })).toBe("redraft-or-ask");
    expect(hold({ leased: true })).toBe("leased");
  });

  test("understand, retry, done and implements", () => {
    expect(isAsk({ source: { intent: { answer: "x" } } })).toBe(true);
    expect([understandOutcome("proceed"), understandOutcome("refuse"), understandOutcome("redraft"), understandOutcome("ask")]).toEqual([null, "dropped", "redraft", "ask"]);
    const claims = [{ token: "t1", ended: "released", outcome: "not_done", attempt: true }];
    expect(retryState({}, claims, { exhausted: false }, false)).toEqual({ possible: true, after: "t1", asked: false });
    expect(retryState({ retry: { after: "t1", by: "a" } }, claims, { exhausted: false }, false)).toMatchObject({ asked: true });
    expect(retryState({}, claims, { exhausted: true }, false)).toMatchObject({ possible: false, reason: "attempts-exhausted" });
    expect(retryState({}, [], { exhausted: false }, false)).toMatchObject({ possible: false, reason: "no-failed-build" });
    const unit = { id: "AC-1", verification: "unit", met: true };
    expect(doneVerdict({ finished: true, reverted: [] }, { ran: true, ok: true }, [unit])).toEqual({ done: true });
    expect(doneVerdict({ finished: true, reverted: [] }, { ran: true, ok: true }, [unit, { id: "AC-2", verification: "manual", met: false }])).toMatchObject({ done: false });
    expect(doneVerdict({ finished: true, reverted: ["x"] }, { ran: true, ok: true }, [unit])).toMatchObject({ done: false });
    expect(doneVerdict({ finished: true, reverted: [] }, { ran: true, ok: false }, [unit])).toMatchObject({ done: false });
    expect(
      proposeImplements(
        [
          { path: "a.ts", decisions: [{ id: "d-1", state: "decided", granularity: "path" }, { id: "d-2", state: "decided", granularity: "member" }, { id: "d-3", state: "proposed", granularity: "path" }] },
          { path: "b.ts", decisions: [{ id: "d-1", state: "decided", granularity: "path" }, { id: "d-4", state: "ratified", granularity: "path" }] },
        ],
        ["d-4"],
      ),
    ).toEqual([{ decision: "d-1", paths: ["a.ts", "b.ts"] }]);
  });
});
