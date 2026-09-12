/**
 * The escape hatch's two safety properties (#2411, #2412).
 *
 * `shellCmd` runs a command chant did not write and cannot model, which is
 * what makes both of these different from every other activity: nothing here
 * can know whether repeating the command is safe, or how much it will say.
 */

import { describe, test, expect } from "vitest";
import { shellCmd } from "./shell";
import { shell } from "../builders";
import { ACTIVITY_PROFILES } from "../activity-profiles";

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
    expect(out.length).toBe(bytes);
  });

  test("stdout is returned trimmed, as before", async () => {
    expect(await shellCmd({ cmd: "echo hello" })).toBe("hello");
  });

  test("a non-zero exit still rejects", async () => {
    await expect(shellCmd({ cmd: "exit 3" })).rejects.toThrow();
  });

  test("cwd and env reach the command", async () => {
    const out = await shellCmd({ cmd: "pwd && echo $CHANT_SHELL_TEST", cwd: "/tmp", env: { CHANT_SHELL_TEST: "set" } });
    expect(out).toContain("set");
  });
});
