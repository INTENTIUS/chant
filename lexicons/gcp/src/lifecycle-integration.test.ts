/**
 * Cross-lexicon lifecycle integration (#163) — GCP row.
 *
 * Drives the REAL gcpPlugin through core's live-import driver and the changeset
 * path, with the `kubectl` (Config Connector) edge mocked.
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

const { gcpPlugin } = await import("./plugin");
const { liveImportFromPlugins } = await import("@intentius/chant/cli/commands/import");
const { buildChangeSet } = await import("@intentius/chant/lifecycle/change-set");

const liveBucket = {
  apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
  kind: "StorageBucket",
  metadata: { name: "my-bucket", namespace: "default", uid: "u-1" },
  spec: { location: "US", storageClass: "STANDARD" },
};

describe("gcp lifecycle integration (#163)", () => {
  beforeEach(() => execMock.mockReset());

  test("live-import driver: real exportResources → IR → generated source", async () => {
    execMock.mockImplementation((cmd?: string) => {
      if (cmd?.includes("api-resources")) {
        return { stdout: "storagebuckets.storage.cnrm.cloud.google.com\n", stderr: "" };
      }
      if (cmd?.includes("storagebuckets.storage.cnrm")) {
        return { stdout: JSON.stringify({ items: [liveBucket] }), stderr: "" };
      }
      return { stdout: JSON.stringify({ items: [] }), stderr: "" };
    });
    const output = mkdtempSync(join(tmpdir(), "chant-gcp-li-"));
    try {
      const result = await liveImportFromPlugins([gcpPlugin], {
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
      expect(all).toContain("bucket");
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("changeset path: real describeResources → buildChangeSet verdicts", async () => {
    execMock.mockImplementation((cmd?: string) =>
      cmd?.includes("data-bucket")
        ? {
            stdout: JSON.stringify({
              metadata: { name: "data-bucket", namespace: "config-control", uid: "uid-1" },
              status: { conditions: [{ type: "Ready", status: "True" }] },
            }),
            stderr: "",
          }
        : new Error("not found"),
    );

    const observedNow = await gcpPlugin.describeResources!({
      environment: "prod",
      buildOutput: "",
      entityNames: ["dataBucket"],
      entities: new Map([
        [
          "dataBucket",
          {
            entityType: "GCP::Storage::Bucket",
            props: { metadata: { name: "data-bucket", namespace: "config-control" } },
          },
        ],
      ]),
    });
    expect(observedNow.dataBucket?.type).toBe("GCP::Storage::Bucket");

    const cs = buildChangeSet("prod", {
      declared: new Set(["pubsubTopic"]),
      observedNow,
      observedThen: undefined,
    });
    const byName = Object.fromEntries(cs.entries.map((e) => [e.name, e.action]));
    expect(byName.pubsubTopic).toBe("create");
    expect(byName.dataBucket).toBe("adopt");

    const cs2 = buildChangeSet("prod", {
      declared: new Set(["dataBucket"]),
      observedNow,
      observedThen: undefined,
    });
    expect(cs2.entries.find((e) => e.name === "dataBucket")!.action).toBe("noop");
  });
});
