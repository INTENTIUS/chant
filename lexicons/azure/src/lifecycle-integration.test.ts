/**
 * Cross-lexicon lifecycle integration (#163) — Azure row.
 *
 * Drives the REAL azurePlugin through core's live-import driver and the
 * changeset path, with the `az` CLI edge mocked.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
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

const { azurePlugin } = await import("./plugin");
const { liveImportFromPlugins } = await import("@intentius/chant/cli/commands/import");
const { buildChangeSet } = await import("@intentius/chant/lifecycle/change-set");
const { normalizeObservation } = await import("@intentius/chant/observation");
const { describeObservationConformance } = await import("@intentius/chant-test-utils");

const liveTemplate = {
  $schema:
    "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
  contentVersion: "1.0.0.0",
  resources: [
    {
      type: "Microsoft.Storage/storageAccounts",
      apiVersion: "2021-09-01",
      name: "mystore",
      location: "eastus",
      properties: {},
    },
  ],
};

const resourceShow = {
  id: "/subscriptions/s/resourceGroups/prod/providers/Microsoft.Storage/storageAccounts/mystore",
  name: "mystore",
  type: "Microsoft.Storage/storageAccounts",
  location: "eastus",
  properties: { provisioningState: "Succeeded" },
};

/** The Azure reads speak ARM over `fetch` now (#1212), so that is the seam. */
const stubArm = (respond: () => { status: number; text: string }): void => {
  vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
    const r = respond();
    return { status: r.status, text: () => Promise.resolve(r.text) };
  }) as unknown as typeof fetch);
};

describe("azure lifecycle integration (#163)", () => {
  beforeEach(() => execMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  test("live-import driver: real exportResources → IR → generated source", async () => {
    execMock.mockReturnValue({ stdout: JSON.stringify(liveTemplate), stderr: "" });
    const output = mkdtempSync(join(tmpdir(), "chant-azure-li-"));
    try {
      const result = await liveImportFromPlugins([azurePlugin], {
        environment: "prod",
        output,
        force: true,
      });
      expect(result.success).toBe(true);
      expect(result.generatedFiles.length).toBeGreaterThan(0);
      const all = readdirSync(output)
        .map((f) => readFileSync(join(output, f), "utf-8"))
        .join("\n");
      expect(all).toContain("mystore");
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("changeset path: real describeResources → buildChangeSet verdicts", async () => {
    stubArm(() => ({ status: 200, text: JSON.stringify(resourceShow) }));

    const { resources: observedNow } = normalizeObservation(
      await azurePlugin.describeResources!({
        environment: "prod",
        buildOutput: "",
        entityNames: ["myStore"],
        entities: new Map([
          ["myStore", { entityType: "Microsoft.Storage/storageAccounts", props: { name: "mystore" } }],
        ]),
      }),
    );
    expect(observedNow.myStore?.type).toBe("Microsoft.Storage/storageAccounts");

    const cs = buildChangeSet("prod", {
      declared: new Set(["myVnet"]),
      observedNow,
      observedThen: undefined,
    });
    const byName = Object.fromEntries(cs.entries.map((e) => [e.name, e.action]));
    expect(byName.myVnet).toBe("create");
    expect(byName.myStore).toBe("adopt");

    const cs2 = buildChangeSet("prod", {
      declared: new Set(["myStore"]),
      observedNow,
      observedThen: undefined,
    });
    expect(cs2.entries.find((e) => e.name === "myStore")!.action).toBe("noop");
  });
});

// The shared conformance suite (#1089).
describeObservationConformance({
  lexicon: "azure",
  ownershipChannel: azurePlugin.ownershipChannel,
  scenarios: [
    {
      name: "a nested ARM type the reader cannot address",
      declared: ["blobSvc", "gone"],
      expectUnobserved: ["blobSvc"],
      expectAbsent: ["gone"],
      run: () => {
        stubArm(() => ({ status: 404, text: JSON.stringify({ error: { code: "ResourceNotFound", message: "not found" } }) }));
        return azurePlugin.describeResources!({
          environment: "prod",
          buildOutput: "",
          entityNames: ["blobSvc", "gone"],
          entities: new Map([
            ["blobSvc", { entityType: "Microsoft.Storage/storageAccounts/blobServices", props: { name: "blob" } }],
            ["gone", { entityType: "Microsoft.Storage/storageAccounts", props: { name: "gone" } }],
          ]),
        });
      },
    },
    {
      name: "an expired login",
      declared: ["myStore"],
      expectUnobserved: ["myStore"],
      run: () => {
        stubArm(() => ({
          status: 401,
          text: JSON.stringify({ error: { code: "AuthenticationFailed", message: "Authentication failed." } }),
        }));
        return azurePlugin.describeResources!({
          environment: "prod",
          buildOutput: "",
          entityNames: ["myStore"],
          entities: new Map([
            ["myStore", { entityType: "Microsoft.Storage/storageAccounts", props: { name: "mystore" } }],
          ]),
        });
      },
    },
  ],
});
