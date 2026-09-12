/**
 * The escape hatch's safety properties (#2411, #2412) and what it publishes
 * (#2413, #2414).
 *
 * `shellCmd` runs a command chant did not write and cannot model, which is
 * what makes these different from every other activity: nothing here can know
 * whether repeating the command is safe, how much it will say, or what a
 * non-zero exit means.
 */

import { describe, test, expect } from "vitest";
import { z } from "zod";
import { shellCmd } from "./shell";
import { shellCmdContract } from "./activity-contracts";
import { shell } from "../builders";
import { phase } from "../builders";
import { collectStepOutputRefs, stepOutput, validateStepOutputRefs } from "../step-output-ref";
import { ACTIVITY_PROFILES } from "../activity-profiles";
import { runOpLocally } from "../local-executor";
import { memoryGateLedgerPort } from "../gate";
import type { ActivityFn } from "../activity-registry";
import type { ShellCmdArgs, ShellCmdResult } from "./shell";

describe("the at-most-once default (#2411)", () => {
  test("shell() asks for a profile that does not retry", () => {
    const step = shell("echo hi");
    expect(step.profile).toBe("atMostOnce");
    expect(ACTIVITY_PROFILES.atMostOnce.retry.maximumAttempts).toBe(1);
  });

  test("an author who knows the command is safe to repeat can still say so", () => {
    // The direction that matters: retrying is opt-in, because it is the claim
    // that needs evidence about the command.
    expect(shell("echo hi", { profile: "fastIdempotent" }).profile).toBe("fastIdempotent");
    expect(ACTIVITY_PROFILES.fastIdempotent.retry.maximumAttempts).toBeGreaterThan(1);
  });

  test("the profile allows a long command, since a shell step is often a build", () => {
    expect(ACTIVITY_PROFILES.atMostOnce.timeout).toBe("20m");
  });
});

describe("the stdout ceiling (#2412)", () => {
  test("a command producing well over 1 MiB completes instead of rejecting", async () => {
    // Node's default maxBuffer is 1 MiB and this activity was the only exec
    // site leaving it unset. 4 MiB is comfortably past the old ceiling and
    // far short of the new one.
    const bytes = 4 * 1024 * 1024;
    const out = await shellCmd({ cmd: `node -e "process.stdout.write('x'.repeat(${bytes}))"` });
    expect(out.stdout.length).toBe(bytes);
  });

  test("stdout is returned trimmed, as before", async () => {
    expect((await shellCmd({ cmd: "echo hello" })).stdout).toBe("hello");
  });

  test("cwd and env reach the command", async () => {
    const out = await shellCmd({ cmd: "pwd && echo $CHANT_SHELL_TEST", cwd: "/tmp", env: { CHANT_SHELL_TEST: "set" } });
    expect(out.stdout).toContain("set");
  });
});

describe("what a shell step publishes (#2413)", () => {
  test("the contract declares a return schema, so a later step may reference it", () => {
    const returns = shellCmdContract.returns as z.ZodTypeAny | undefined;
    expect(returns).toBeDefined();
    expect(returns!.parse({ stdout: "a", stderr: "b", exitCode: 0 })).toEqual({ stdout: "a", stderr: "b", exitCode: 0 });
  });

  test("a step reading a shell step's stdout passes OPS013", () => {
    const host = shell("echo db.internal", { id: "host" });
    const smoke = shell("./smoke.sh", { env: { HOST: host.out.stdout } });
    const issues = validateStepOutputRefs(
      { name: "deploy", phases: [phase("Go", [host, smoke])] },
      new Map([["shellCmd", shellCmdContract]]),
    );
    expect(issues).toEqual([]);
  });

  test("a path the shell result does not declare is still flagged", () => {
    const host = shell("echo db.internal", { id: "host" });
    const smoke = shell("./smoke.sh", { env: { HOST: stepOutput(host, "stdoutt") } });
    const issues = validateStepOutputRefs(
      { name: "deploy", phases: [phase("Go", [host, smoke])] },
      new Map([["shellCmd", shellCmdContract]]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('output path "stdoutt"');
  });

  test("stderr survives the call instead of being printed and dropped", async () => {
    const out = await shellCmd({ cmd: `node -e "process.stderr.write('warned')"` });
    expect(out).toMatchObject({ stdout: "", stderr: "warned", exitCode: 0 });
  });

  test("a non-zero exit still rejects, and the code is in the message", async () => {
    await expect(shellCmd({ cmd: "exit 3" })).rejects.toThrow(/exited 3 \(expected 0\)/);
  });

  test("a code the author named resolves, carrying output and the code", async () => {
    // `diff` exits 1 to report a difference. Nothing about that is a failure,
    // and before this the whole step was one.
    const out = await shellCmd({ cmd: `node -e "process.stdout.write('changed'); process.exit(1)"`, okExit: [0, 1] });
    expect(out).toEqual({ stdout: "changed", stderr: "", exitCode: 1 });
  });

  test("a code the author did not name still rejects", async () => {
    await expect(shellCmd({ cmd: "exit 2", okExit: [0, 1] })).rejects.toThrow(/exited 2 \(expected 0, 1\)/);
  });

  test("a signal kill rejects even when its code is named", async () => {
    // A timeout or Ctrl-C is not an exit status the author said anything
    // about, so `okExit` must not swallow it.
    const ac = new AbortController();
    const running = shellCmd({ cmd: "sleep 5", okExit: [0, 1, 143] }, ac.signal);
    ac.abort();
    await expect(running).rejects.toThrow();
  });
});

describe("a reference reaching the command (#2414)", () => {
  test("a reference in env typechecks, which is the whole gap", () => {
    const host = shell("echo db.internal", { id: "host" });
    // No `as` cast: before #2414 `WithStepRefs` was shallow, so a reference
    // inside `env`'s Record<string, string> was a type error even though the
    // executor resolved it and the lint rule accepted it.
    const smoke = shell("./smoke.sh", { env: { HOST: host.out.stdout, MODE: "ci" } });
    expect(collectStepOutputRefs(smoke.args)).toEqual([
      expect.objectContaining({ step: "host", path: "stdout" }),
    ]);
    expect((smoke.args as { env: Record<string, string> }).env.MODE).toBe("ci");
  });

  test("the executor carries it into the next command's environment, end to end", async () => {
    const host = shell("echo db.internal", { id: "host" });
    const smoke = shell("echo reached $HOST", { env: { HOST: host.out.stdout }, id: "smoke" });

    const seen: ShellCmdResult[] = [];
    const spy: ActivityFn = async (args, signal) => {
      const out = await shellCmd(args as unknown as ShellCmdArgs, signal);
      seen.push(out);
      return out;
    };

    const result = await runOpLocally(
      { name: "deploy", overview: "", phases: [phase("Go", [host, smoke])] },
      new Map([["shellCmd", spy]]),
      ACTIVITY_PROFILES,
      undefined,
      { gates: memoryGateLedgerPort() },
    );

    expect(result.status).toBe("ok");
    expect(seen.map((s) => s.stdout)).toEqual(["db.internal", "reached db.internal"]);
  });
});
