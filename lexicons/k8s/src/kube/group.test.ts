import { describe, test, expect } from "vitest";
import { kubeCommandGroup } from "./group";

describe("kubeCommandGroup (chant #1079)", () => {
  test("mounts as \"kube\" and carries every verb the issue names", () => {
    const group = kubeCommandGroup();
    expect(group.name).toBe("kube");
    const names = group.commands.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["version", "get", "describe", "logs", "events", "top", "wait", "source", "apply", "delete"]),
    );
  });

  test("every verb carries a non-empty description (shown in --help composition)", () => {
    const group = kubeCommandGroup();
    for (const command of group.commands) {
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  test("version still behaves exactly as #1078 shipped it (unchanged tenant)", async () => {
    const group = kubeCommandGroup();
    const version = group.commands.find((c) => c.name === "version")!;
    const logSpy = (await import("vitest")).vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const code = await version.handler({ verb: "version", rawArgs: ["--format", "json"] });
      expect(code).toBe(0);
      expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toHaveProperty("schemaVersion");
    } finally {
      logSpy.mockRestore();
    }
  });
});
