import { describe, test, expect, vi } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFallbackFilesSandboxed } from "./run";
import { forkSandboxed, settleOnExitAfterChannelDrains } from "./fork";
import { generateConfigDriverSource, generateDriverSource, generatePolicyDriverSource, sendFunctionSource } from "./driver";

/**
 * chant#2461 — a child that ends without a usable result says which way it did.
 *
 * The parent had one sentence for three unrelated situations: `child exited
 * before reporting results (code N, signal S)`. The one seen in the wild is the
 * hardest to read — exit code 0, empty stderr, no message — because it reads as
 * if the child was cut off, and it was not. It ran to completion and sent
 * nothing.
 *
 * These tests pin the two mechanisms that produce that signature, against real
 * forked children rather than a mock, because the whole question is what Node
 * actually does:
 *
 *   - an `await` that never settles, which drains the loop and exits 0
 *   - a payload the parent's `isResponse` refuses, which used to be dropped in
 *     silence and then reported as though nothing had been sent
 *
 * A third mechanism, the one the issue first proposed, was ruled out early on
 * a test that blocked the parent (`message` won 60 of 60) and turned out to be
 * the real one: under concurrent load the parent can handle a child's `exit`
 * before the `message` it had already written. A stress run of the real
 * `evaluateConfigSandboxed` lost 3 of 800 that way. The parent now waits for
 * the IPC channel to drain before it reads an exit, and the drivers await
 * their `process.send` callback; both are pinned below.
 */
function runChild(source: string): Promise<{ code: number | null; message: unknown; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), "chant-fork-diag-"));
  const file = join(dir, "child.mjs");
  writeFileSync(file, source);
  return new Promise((resolve) => {
    const child = fork(file, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stderr = "";
    let message: unknown;
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("message", (m) => { message = m; });
    child.on("exit", (code) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ code, message, stderr });
    });
  });
}

describe("why a sandboxed child ends without a result (chant#2461)", () => {
  test("an await that never settles exits 0, silently, having sent nothing", async () => {
    // The observed signature, reproduced. `main().catch(...)` catches a
    // REJECTION; a promise that never settles is not one, so the driver's own
    // fatal-payload path never runs either.
    const r = await runChild(
      'async function main() { await new Promise(() => {}); process.send({ ok: true }); }\n' +
        "main().catch((e) => process.send({ fatal: String(e) }));\n",
    );

    expect(r.code).toBe(0);
    expect(r.message).toBeUndefined();
    expect(r.stderr.trim()).toBe("");
  });

  test("a child that sends and falls off the end gets its message through", async () => {
    // Usually true even on a bare `exit` handler; the drain wait is what makes
    // it true every time. See the settleOnExitAfterChannelDrains tests below.
    const results = await Promise.all(
      Array.from({ length: 12 }, () => runChild("process.send({ ok: true });\n")),
    );

    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.message).toEqual({ ok: true });
    }
  });

  test("a rejection still reaches the parent, so the fatal path is not what broke", async () => {
    // Establishes the contrast: the driver's catch works. It is specifically an
    // unsettled promise that escapes it.
    const r = await runChild(
      'async function main() { throw new Error("boom"); }\n' +
        "main().catch((e) => process.send({ fatal: String(e) }));\n",
    );

    expect(r.message).toEqual({ fatal: "Error: boom" });
  });

  test("a project file with an unsettled top-level await reproduces it end to end", async () => {
    // The run path's real mechanism, not a stand-in. `main()` does
    // `await import(<project file>)` per run-fallback file, module scope is
    // arbitrary project source, and a top level that awaits something which
    // never settles makes that import never complete. Nothing keeps the loop
    // alive, so Node exits 0 having sent nothing.
    //
    // This is what the diagnostic's wording is checked against. Before
    // chant#2461 it said only "child exited before reporting results", which
    // gave a reader nothing to look at.
    const root = mkdtempSync(join(tmpdir(), "chant-tla-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "hangs.ts"),
        "await new Promise<void>(() => {});\nexport const never = { reached: true };\n",
      );

      const result = await runFallbackFilesSandboxed([join(root, "src", "hangs.ts")], root);

      const message = result.errors.map((e) => e.message).join("\n");
      expect(message).toContain("child exited before reporting results (code 0, signal null)");

      // chant#2461's user-facing half: the child names the file it was
      // importing when its loop drained. It cannot `process.send` from an exit
      // handler — that is asynchronous and the channel will never be serviced —
      // so it writes synchronously to stderr, which the parent captures and
      // forwards. Without this the build dies silently and nothing anywhere
      // says which file.
      expect(message).toContain("never finished evaluating");
      expect(message).toContain("hangs.ts");
      expect(message).toContain("top-level");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

/** A stand-in for a ChildProcess: just the events and the `connected` flag the helper reads. */
function fakeChild(connected: boolean): ChildProcess & EventEmitter {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  (child as { connected: boolean }).connected = connected;
  return child;
}

describe("settleOnExitAfterChannelDrains (chant#2461)", () => {
  test("an exit handled before the last message waits for the channel, so the message wins", () => {
    // The observed ordering: exit first, the already-written message after,
    // then the channel's EOF. Settling on exit alone dropped the message.
    const child = fakeChild(true);
    const order: string[] = [];
    child.on("message", () => order.push("message"));
    settleOnExitAfterChannelDrains(child, (code) => order.push(`exit:${code}`));

    child.emit("exit", 0, null);
    child.emit("message", { ok: true });
    expect(order).toEqual(["message"]);

    child.emit("disconnect");
    expect(order).toEqual(["message", "exit:0"]);
  });

  test("a channel that has already closed settles on exit straight away", () => {
    const child = fakeChild(false);
    const onExit = vi.fn();
    settleOnExitAfterChannelDrains(child, onExit);
    child.emit("exit", 3, null);
    expect(onExit).toHaveBeenCalledWith(3, null);
  });

  test("a channel that never reports closed is bounded by the grace period", () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild(true);
      const onExit = vi.fn();
      settleOnExitAfterChannelDrains(child, onExit, 50);
      child.emit("exit", 0, null);
      vi.advanceTimersByTime(49);
      expect(onExit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onExit).toHaveBeenCalledTimes(1);
      child.emit("disconnect");
      expect(onExit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("real sandboxed children that send and return all resolve, many at once", async () => {
    // The shape of the stress harness, small enough for CI: a --permission
    // child that sends and returns, through forkSandboxed's settle logic.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-2461-many-")));
    try {
      const file = join(dir, "child.mjs");
      writeFileSync(file, 'process.send({ kind: "chant-config", ok: true, config: { pad: "x".repeat(65536) } });\n');
      const isResponse = (v: unknown): v is { kind: string } =>
        typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "chant-config";
      const results = await Promise.all(
        Array.from({ length: 32 }, () =>
          forkSandboxed(
            { bundlePath: file, bundleDir: dir, projectRealpath: dir, externalReadPaths: [], env: { PATH: process.env.PATH ?? "" }, timeoutMs: 60_000, label: "many", outputPrefix: "[t]" },
            isResponse,
          ),
        ),
      );
      expect(results.every((r) => r.kind === "chant-config")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("driver send awaits delivery and fails loudly (chant#2461)", () => {
  const harness = (body: string): string =>
    ['import { writeSync } from "node:fs";', ...sendFunctionSource(), body].join("\n");

  test("a send that succeeds resolves, and the code after it runs", async () => {
    const r = await runChild(harness('await send({ ok: 1 }); writeSync(2, "after\\n");'));
    expect(r.code).toBe(0);
    expect(r.message).toEqual({ ok: 1 });
    expect(r.stderr).toBe("after\n");
  });

  test("a send on a closed channel exits non-zero with the reason on stderr", async () => {
    const r = await runChild(harness('process.disconnect(); await send({ ok: 1 }); writeSync(2, "unreachable\\n");'));
    expect(r.code).toBe(1);
    expect(r.message).toBeUndefined();
    expect(r.stderr).toContain("could not hand its result to the parent");
    expect(r.stderr).toContain("chant#2461");
    expect(r.stderr).not.toContain("unreachable");
  });

  test("a payload that cannot be serialized exits non-zero with the reason on stderr", async () => {
    const r = await runChild(harness("await send({ big: 1n });"));
    expect(r.code).toBe(1);
    expect(r.message).toBeUndefined();
    expect(r.stderr).toContain("could not hand its result to the parent");
  });

  test("every driver awaits or returns every send", () => {
    // A bare `send(...)` statement would let main() return before the write
    // completes. The only unawaited call allowed is main().catch's, whose
    // promise is the last thing the module does.
    const sources = {
      config: generateConfigDriverSource("/tmp/project/chant.config.ts"),
      run: generateDriverSource({ files: ["/tmp/project/a.ts"], buildRoot: "/tmp/project" }),
      policy: generatePolicyDriverSource(["/tmp/project/policy.ts"]),
    };
    for (const [name, source] of Object.entries(sources)) {
      const bare = source
        .split("\n")
        .filter((line) => /^\s*(send|fail)\(/.test(line))
        .filter((line) => !/^\s*send\(\{[^\n]*fatal: true|^\s*send\(\{ kind: "chant-config", ok: false, error: classifyChildError\([^)]*, err\)\.toJSON\(\) \}\),$/.test(line));
      expect({ name, bare }).toEqual({ name, bare: [] });
    }
  });
});
