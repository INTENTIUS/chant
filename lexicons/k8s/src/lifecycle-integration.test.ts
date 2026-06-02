/**
 * Cross-lexicon lifecycle integration (#163) — Kubernetes row.
 *
 * Drives the REAL k8sPlugin through core's live-import driver and the changeset
 * path, with the `kubectl` edge mocked.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    exec: (
      cmd: string,
      cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
    ) => {
      const r = execMock(cmd);
      queueMicrotask(() =>
        r instanceof Error
          ? cb(r, { stdout: "", stderr: "" })
          : cb(null, r as { stdout: string; stderr: string }),
      );
    },
  };
});

const { k8sPlugin } = await import("./plugin");
const { liveImportFromPlugins } = await import("@intentius/chant/cli/commands/import");
const { buildChangeSet } = await import("@intentius/chant/lifecycle/change-set");

const liveDeployment = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "default", uid: "d-1" },
  spec: { replicas: 3, selector: { matchLabels: { app: "web" } } },
};

const emptyList = { stdout: JSON.stringify({ items: [] }), stderr: "" };

describe("k8s lifecycle integration (#163)", () => {
  beforeEach(() => execMock.mockReset());

  test("live-import driver: real exportResources → IR → generated source", async () => {
    execMock.mockImplementation((cmd?: string) =>
      cmd?.includes("get deployment.apps")
        ? { stdout: JSON.stringify({ items: [liveDeployment] }), stderr: "" }
        : emptyList,
    );
    const output = mkdtempSync(join(tmpdir(), "chant-k8s-li-"));
    try {
      const result = await liveImportFromPlugins([k8sPlugin], {
        environment: "prod",
        output,
        force: true,
      });
      expect(result.success).toBe(true);
      expect(result.generatedFiles.length).toBeGreaterThan(0);
      const all = readdirSync(output)
        .map((f) => readFileSync(join(output, f), "utf-8"))
        .join("\n")
        .toLowerCase();
      expect(all).toContain("deployment");
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("changeset path: real describeResources → buildChangeSet verdicts", async () => {
    execMock.mockImplementation((cmd?: string) =>
      cmd?.includes("deployment.apps web")
        ? {
            stdout: JSON.stringify({
              metadata: { name: "web", namespace: "prod", uid: "uid-1" },
              status: { readyReplicas: 3, replicas: 3 },
            }),
            stderr: "",
          }
        : new Error("not found"),
    );

    const observedNow = await k8sPlugin.describeResources!({
      environment: "prod",
      buildOutput: "",
      entityNames: ["web"],
      entities: new Map([
        ["web", { entityType: "K8s::Apps::Deployment", props: { metadata: { name: "web", namespace: "prod" } } }],
      ]),
    });
    expect(observedNow.web?.type).toBe("K8s::Apps::Deployment");

    const cs = buildChangeSet("prod", {
      declared: new Set(["webSvc"]),
      observedNow,
      observedThen: undefined,
    });
    const byName = Object.fromEntries(cs.entries.map((e) => [e.name, e.action]));
    expect(byName.webSvc).toBe("create");
    expect(byName.web).toBe("adopt");

    const cs2 = buildChangeSet("prod", {
      declared: new Set(["web"]),
      observedNow,
      observedThen: undefined,
    });
    expect(cs2.entries.find((e) => e.name === "web")!.action).toBe("noop");
  });
});
