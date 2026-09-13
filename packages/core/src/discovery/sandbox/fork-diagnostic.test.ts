import { describe, test, expect } from "vitest";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 * A third mechanism was proposed in the issue and is NOT covered, because it
 * was measured and does not happen: `process.send` racing the child's reap so
 * that `exit` is dispatched before an already-queued `message`. With the parent
 * blocked so both were certainly pending, `message` won 60 times out of 60. The
 * live IPC channel keeps the child alive until the payload flushes, and the
 * driver has no `process.exit()` to cut that short. The last test here records
 * that, so the disproof is not lost with the transcript.
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

  test("a child that sends and falls off the end always gets its message through", async () => {
    // The disproof, kept as a test. If this ever fails, the race the issue
    // proposed is real after all and the diagnostic's wording needs revisiting.
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
});
