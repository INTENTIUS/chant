/**
 * The wake gate (#1981): coalescing, the floor, and abort.
 *
 * Real timers with small floors rather than fake ones: the gate is nothing but
 * two `setTimeout`s racing, and a fake-timer test of that asserts the mock
 * rather than the behaviour.
 */
import { describe, test, expect } from "vitest";
import { createChangeSignalGate, DEFAULT_SIGNAL_FLOOR_MS } from "./change-signal";

describe("createChangeSignalGate", () => {
  test("no signal: the wait runs the full interval and reports the timer", async () => {
    const gate = createChangeSignalGate({ floorMs: 10 });
    gate.roundStarted();
    const started = Date.now();
    expect(await gate.wait(60)).toBe("timer");
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(gate.wakeCount).toBe(0);
  });

  test("a signal past the floor wakes the sleep early", async () => {
    const gate = createChangeSignalGate({ floorMs: 0 });
    gate.roundStarted();
    const started = Date.now();
    const waiting = gate.wait(5_000);
    setTimeout(() => gate.signal(), 10);
    expect(await waiting).toBe("signal");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(gate.wakeCount).toBe(1);
  });

  test("a signal inside the floor waits the floor out rather than waking at once", async () => {
    const gate = createChangeSignalGate({ floorMs: 120 });
    gate.roundStarted();
    const started = Date.now();
    const waiting = gate.wait(5_000);
    gate.signal();
    expect(await waiting).toBe("signal");
    // Woken by the signal, but not before the floor had passed.
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  test("a storm of signals inside one floor window costs exactly one wake", async () => {
    const gate = createChangeSignalGate({ floorMs: 60 });
    gate.roundStarted();
    const waiting = gate.wait(5_000);
    for (let i = 0; i < 500; i++) gate.signal();
    expect(await waiting).toBe("signal");
    expect(gate.signalCount).toBe(500);
    expect(gate.wakeCount).toBe(1);
  });

  test("the floor is measured from the round, so a steady stream cannot starve the tick", async () => {
    const gate = createChangeSignalGate({ floorMs: 80 });
    gate.roundStarted();
    const started = Date.now();
    const waiting = gate.wait(5_000);
    // A signal every 10ms. A debounce would push the deadline out forever.
    const drip = setInterval(() => gate.signal(), 10);
    const reason = await waiting;
    clearInterval(drip);
    expect(reason).toBe("signal");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("a signal arriving between rounds is honoured by the next wait, not lost", async () => {
    const gate = createChangeSignalGate({ floorMs: 0 });
    gate.roundStarted();
    gate.signal(); // nothing is sleeping yet
    expect(await gate.wait(5_000)).toBe("signal");
  });

  test("roundStarted clears the pending flag, so one signal never wakes two rounds", async () => {
    const gate = createChangeSignalGate({ floorMs: 0 });
    gate.roundStarted();
    gate.signal();
    expect(await gate.wait(5_000)).toBe("signal");
    gate.roundStarted();
    expect(await gate.wait(40)).toBe("timer");
    expect(gate.wakeCount).toBe(1);
  });

  test("abort resolves rather than throwing, before and during a wait", async () => {
    const gate = createChangeSignalGate({ floorMs: 0 });
    const already = new AbortController();
    already.abort();
    expect(await gate.wait(5_000, already.signal)).toBe("aborted");

    const controller = new AbortController();
    const waiting = gate.wait(5_000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    expect(await waiting).toBe("aborted");
  });

  test("a signal after abort does nothing", async () => {
    const gate = createChangeSignalGate({ floorMs: 0 });
    const controller = new AbortController();
    const waiting = gate.wait(5_000, controller.signal);
    controller.abort();
    expect(await waiting).toBe("aborted");
    gate.signal();
    expect(gate.wakeCount).toBe(0);
  });

  test("signal() carries no payload: the type has no argument and the call ignores one", () => {
    const gate = createChangeSignalGate();
    expect(gate.signal.length).toBe(0);
    // A caller that fabricates an event has nowhere to put it: the extra
    // argument is dropped, and the gate's only state is a boolean.
    (gate.signal as (...args: unknown[]) => void)({ kind: "Deployment", name: "fabricated" });
    expect(gate.signalCount).toBe(1);
  });

  test("the documented floor is a real, positive default", () => {
    expect(DEFAULT_SIGNAL_FLOOR_MS).toBe(5_000);
  });
});
