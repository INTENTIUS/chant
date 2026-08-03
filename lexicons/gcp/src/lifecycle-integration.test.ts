/**
 * Cross-lexicon lifecycle integration (#163) — GCP row.
 *
 * Drives the REAL gcpPlugin through core's live-import driver and the changeset
 * path. Two edges are mocked, because since #1209 the plugin has two
 * transports: `describeResources` reads GCP REST (stubbed `fetch`), while
 * `exportResources` and the deep reader still go through Config Connector
 * (stubbed `exec`).
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

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
// The REST reader resolves a project before it can build a URL; without one it
// correctly reports a hole rather than reading anything.
process.env.GOOGLE_CLOUD_PROJECT = "test-project";

/** A GCP REST reply, as the read client consumes it. */
function restReply(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) };
}

const { gcpPlugin } = await import("./plugin");
const { liveImportFromPlugins } = await import("@intentius/chant/cli/commands/import");
const { buildChangeSet } = await import("@intentius/chant/lifecycle/change-set");
const { normalizeObservation } = await import("@intentius/chant/observation");
const { describeObservationConformance } = await import("@intentius/chant-test-utils");

const liveBucket = {
  apiVersion: "storage.cnrm.cloud.google.com/v1beta1",
  kind: "StorageBucket",
  metadata: { name: "my-bucket", namespace: "default", uid: "u-1" },
  spec: { location: "US", storageClass: "STANDARD" },
};

describe("gcp lifecycle integration (#163)", () => {
  beforeEach(() => {
    execMock.mockReset();
    fetchMock.mockReset();
  });

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
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes("data-bucket")
          // No chant marker: live but not chant's, which is what makes the
          // changeset propose `adopt` rather than `delete`.
          ? restReply(200, { id: "b/data-bucket", labels: { team: "data" } })
          : restReply(404, { error: "not found" }),
      ),
    );

    const { resources: observedNow } = normalizeObservation(
      await gcpPlugin.describeResources!({
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
      }),
    );
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

// The shared conformance suite (#1089).
describeObservationConformance({
  lexicon: "gcp",
  ownershipChannel: gcpPlugin.ownershipChannel,
  scenarios: [
    {
      name: "an entity type this lexicon cannot map to a GCP kind",
      declared: ["notGcp", "gone"],
      expectUnobserved: ["notGcp"],
      expectAbsent: ["gone"],
      run: () => {
        fetchMock.mockResolvedValue(restReply(404, { error: "not found" }));
        return gcpPlugin.describeResources!({
          environment: "prod",
          buildOutput: "",
          entityNames: ["notGcp", "gone"],
          entities: new Map([
            ["notGcp", { entityType: "AWS::S3::Bucket", props: { metadata: { name: "not-gcp" } } }],
            ["gone", { entityType: "GCP::Storage::Bucket", props: { metadata: { name: "gone" } } }],
          ]),
        });
      },
    },
    {
      name: "an unreachable GCP endpoint",
      declared: ["dataBucket"],
      expectUnobserved: ["dataBucket"],
      run: () => {
        fetchMock.mockRejectedValue(new Error("dial tcp: i/o timeout"));
        return gcpPlugin.describeResources!({
          environment: "prod",
          buildOutput: "",
          entityNames: ["dataBucket"],
          entities: new Map([
            ["dataBucket", { entityType: "GCP::Storage::Bucket", props: { metadata: { name: "data-bucket" } } }],
          ]),
        });
      },
    },
  ],
});
