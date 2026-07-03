/**
 * Tests `q`/`requireTool` (../process-runner.ts) plus `MockProcessRunner`
 * itself (./__tests__/mock-process-runner.ts) — no real process spawned. The
 * real `ProcessRunner`'s `child_process`-backed methods are exercised
 * indirectly by every #610 backend's own tests via the mock; this file
 * covers the shared helpers every one of those backends depends on.
 */

import { describe, expect, it } from "vitest";
import { q, requireTool, ToolNotAvailableError } from "./process-runner";
import { createMockProcessRunner } from "./__tests__/mock-process-runner";

describe("q (shell quoting)", () => {
  it("wraps a plain argument in single quotes", () => {
    expect(q("hello")).toBe("'hello'");
  });

  it("escapes an embedded single quote", () => {
    expect(q("it's")).toBe("'it'\\''s'");
  });
});

describe("requireTool", () => {
  it("resolves silently when the tool is available", async () => {
    const mock = createMockProcessRunner({ tools: { syft: true } });
    await expect(requireTool(mock.runner, "syft", "scan an artifact")).resolves.toBeUndefined();
  });

  it("throws ToolNotAvailableError with an actionable message when the tool is absent", async () => {
    const mock = createMockProcessRunner({ tools: { syft: false } });
    await expect(requireTool(mock.runner, "syft", "scan an artifact")).rejects.toThrow(ToolNotAvailableError);
    await expect(requireTool(mock.runner, "syft", "scan an artifact")).rejects.toThrow(
      /syft.*not installed.*scan an artifact/,
    );
  });
});

describe("MockProcessRunner", () => {
  it("records every run() and available() call", async () => {
    const mock = createMockProcessRunner();
    await mock.runner.available("syft");
    await mock.runner.run("syft dir:. -o spdx-json");
    expect(mock.calls.map((c) => c.command)).toEqual([
      "command -v syft",
      "syft dir:. -o spdx-json",
    ]);
  });

  it("defaults every tool to available unless scripted otherwise", async () => {
    const mock = createMockProcessRunner();
    expect(await mock.runner.available("anything")).toBe(true);
  });

  it("respects defaultAvailable: false", async () => {
    const mock = createMockProcessRunner({ defaultAvailable: false, tools: { syft: true } });
    expect(await mock.runner.available("syft")).toBe(true);
    expect(await mock.runner.available("oras")).toBe(false);
  });

  it("matches a scripted response by command substring", async () => {
    const mock = createMockProcessRunner({ responses: { "cat ": "canned-output" } });
    const { stdout } = await mock.runner.run("cat /tmp/whatever.json");
    expect(stdout).toBe("canned-output");
  });

  it("rejects when the command matches a scripted failure substring", async () => {
    const mock = createMockProcessRunner({ failures: { syft: "syft: command failed" } });
    await expect(mock.runner.run("syft dir:.")).rejects.toThrow("syft: command failed");
  });

  it("setAvailable/setResponse update behavior after construction", async () => {
    const mock = createMockProcessRunner();
    mock.setAvailable("oras", false);
    expect(await mock.runner.available("oras")).toBe(false);
    mock.setResponse("oras discover", '{"manifests":[]}');
    const { stdout } = await mock.runner.run("oras discover --format json foo@sha256:abc");
    expect(stdout).toBe('{"manifests":[]}');
  });
});
