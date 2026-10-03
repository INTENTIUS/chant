import { describe, expect, it } from "vitest";
import { createShellCapability } from "./shell";
import { createMockProcessRunner } from "./__tests__/mock-process-runner";

const ctx = { env: "dev", component: "svc" };

describe("shell (#557)", () => {
  it("runs the command and returns its stdout with exit 0", async () => {
    const mock = createMockProcessRunner({ responses: { "echo hi": "hi\n" } });
    const out = await createShellCapability(mock.runner).run(ctx, { cmd: "echo hi", reason: "demo" });
    expect(out).toEqual({ stdout: "hi\n", exitCode: 0 });
    expect(mock.calls.at(-1)?.command).toBe("echo hi");
  });

  it("prefixes env vars and passes cwd through", async () => {
    const mock = createMockProcessRunner();
    await createShellCapability(mock.runner).run(ctx, {
      cmd: "deploy.sh",
      cwd: "/app",
      env: { FOO: "bar" },
      reason: "vendor CLI not yet wrapped by a capability",
    });
    const call = mock.calls.at(-1)!;
    expect(call.command).toBe("env FOO='bar' deploy.sh");
    expect(call.options?.cwd).toBe("/app");
  });

  it("rejects when the command exits non-zero (surfaces the tool's error)", async () => {
    const mock = createMockProcessRunner({ failures: { "bad-cmd": "boom" } });
    await expect(createShellCapability(mock.runner).run(ctx, { cmd: "bad-cmd", reason: "x" })).rejects.toThrow("boom");
  });

  it("declares no rollback — an escape-hatch shell owns its own compensation", () => {
    expect(createShellCapability(createMockProcessRunner().runner).rollback).toBeUndefined();
  });

  it("exports a release's attributes for a docker compose up, and a value the step sets wins (#3061)", async () => {
    const mock = createMockProcessRunner();
    const release = { version: "sha256:abc", revision: "0123abc" };
    await createShellCapability(mock.runner).run({ ...ctx, release }, { cmd: "docker compose up -d", reason: "compose" });
    expect(mock.calls.at(-1)!.command).toBe(
      "env CHANT_RELEASE_ATTRIBUTES=',service.version=sha256%3Aabc,vcs.ref.head.revision=0123abc' docker compose up -d",
    );
    await createShellCapability(mock.runner).run({ ...ctx, release }, { cmd: "up", env: { CHANT_RELEASE_ATTRIBUTES: "" }, reason: "x" });
    expect(mock.calls.at(-1)!.command).toBe("env CHANT_RELEASE_ATTRIBUTES='' up");
  });
});
