/**
 * Cross-lexicon lifecycle integration (#163) — AWS row.
 *
 * Drives the REAL awsPlugin through core's live-import driver
 * (`liveImportFromPlugins`) and the changeset path (`buildChangeSet`), with the
 * cloud edge (the runtime adapter's spawn) mocked. Proves the seam between core
 * and a real lexicon — not a `createMockPlugin` fixture.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Partial mock (`importOriginal`) rather than a full replacement: this module
// is reachable — via `@intentius/chant`'s own root barrel, not just this
// test's direct imports — from other real exports the plugin/import path
// touches (e.g. `moduleDir`, which `../../lint/config.ts` calls at module
// scope), so replacing the whole module wholesale breaks anything that
// transitively loads one of those, for reasons entirely unrelated to what
// this test is mocking (`spawn`).
const spawnMock = vi.fn();
vi.mock("@intentius/chant/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@intentius/chant/runtime-adapter")>();
  return { ...actual, getRuntime: () => ({ ...actual.getRuntime(), spawn: spawnMock }) };
});

const { awsPlugin } = await import("./plugin");
const { liveImportFromPlugins } = await import("@intentius/chant/cli/commands/import");
const { buildChangeSet } = await import("@intentius/chant/lifecycle/change-set");
const { normalizeObservation } = await import("@intentius/chant/observation");
const { liveEvidenceFromChangeSet, reconcileStatus } = await import("@intentius/chant/lifecycle/status");
const { describeObservationConformance } = await import("@intentius/chant-test-utils");
const { observeResources } = await import("@intentius/chant/lifecycle/observe");
const { DECLARABLE_MARKER } = await import("@intentius/chant/declarable");

const liveTemplate = {
  AWSTemplateFormatVersion: "2010-09-09",
  Resources: {
    MyBucket: { Type: "AWS::S3::Bucket", Properties: { BucketName: "my-bucket" } },
  },
};

const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });

/* The stack reads moved off the CLI onto the CloudFormation Query protocol
 * (#1206), so they are stubbed at `fetch` rather than at `spawn`. The paths
 * still on the CLI — `describeStackStatus`, `exportResources`, and the
 * per-kind property reads — keep using `spawnMock` below. */

const stackResourcesXml = (rows: Array<{ logicalId: string; type: string; physicalId: string }>) =>
  `<DescribeStackResourcesResponse><StackResources>${rows
    .map(
      (r) =>
        `<member><LogicalResourceId>${r.logicalId}</LogicalResourceId><ResourceType>${r.type}</ResourceType>` +
        `<PhysicalResourceId>${r.physicalId}</PhysicalResourceId><ResourceStatus>CREATE_COMPLETE</ResourceStatus>` +
        `<Timestamp>2026-01-01T00:00:00Z</Timestamp></member>`,
    )
    .join("")}</StackResources></DescribeStackResourcesResponse>`;

const stackOutputsXml = (outputs: Record<string, string> = {}) =>
  `<DescribeStacksResponse><Outputs>${Object.entries(outputs)
    .map(([k, v]) => `<member><OutputKey>${k}</OutputKey><OutputValue>${v}</OutputValue></member>`)
    .join("")}</Outputs></DescribeStacksResponse>`;

const queryErrorXml = (code: string, message: string) =>
  `<ErrorResponse><Error><Code>${code}</Code><Message>${message}</Message></Error></ErrorResponse>`;

/** Route a CloudFormation Query call by its `Action`, and answer as CFN would. */
const stubCfn = (route: (action: string) => { status?: number; text: string }): void => {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init: { body: string }) => {
    const action = new URLSearchParams(init.body).get("Action") ?? "";
    const res = route(action);
    return { status: res.status ?? 200, text: () => Promise.resolve(res.text) };
  }) as unknown as typeof fetch);
};

/** The whole-stack refusal both the credentials and the missing-stack cases use. */
const stubCfnError = (code: string, message: string): void =>
  stubCfn(() => ({ status: 400, text: queryErrorXml(code, message) }));

describe("aws lifecycle integration (#163)", () => {
  beforeEach(() => spawnMock.mockReset());
  // A `fetch` stub left standing would serve the next test's stack read, which
  // is how a credentials case can come back looking healthy.
  afterEach(() => vi.restoreAllMocks());

  test("live-import driver: real exportResources → IR → generated source", async () => {
    spawnMock.mockResolvedValue(ok(JSON.stringify({ TemplateBody: liveTemplate })));
    const output = mkdtempSync(join(tmpdir(), "chant-aws-li-"));
    try {
      const result = await liveImportFromPlugins([awsPlugin], {
        environment: "prod",
        output,
        force: true,
      });
      expect(result.success).toBe(true);
      expect(result.generatedFiles.length).toBeGreaterThan(0);
      const all = readdirSync(output)
        .map((f) => readFileSync(join(output, f), "utf-8"))
        .join("\n");
      expect(all).toContain("new Bucket(");
      expect(all).toContain("BucketName");
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("changeset path: real describeResources → buildChangeSet verdicts", async () => {
    stubCfn((action) =>
      action === "DescribeStackResources"
        ? { text: stackResourcesXml([{ logicalId: "MyBucket", type: "AWS::S3::Bucket", physicalId: "my-bucket" }]) }
        : { text: stackOutputsXml() },
    );

    const { resources: observedNow } = normalizeObservation(
      await awsPlugin.describeResources!({
        environment: "prod",
        buildOutput: "",
        entityNames: ["MyBucket"],
        entities: new Map(),
      }),
    );
    expect(observedNow.MyBucket?.type).toBe("AWS::S3::Bucket");
    // Ownership verdicts are total (#1089): DescribeStackResources carries no
    // tags, so the verdict is an explicit `unknown`, not a missing field.
    expect(observedNow.MyBucket?.ownership).toBe("unknown");

    // Declared "MyQueue" is absent from live → create; live "MyBucket" is
    // undeclared and unmarked → adopt (never delete without ownership).
    const cs = buildChangeSet("prod", {
      declared: new Set(["MyQueue"]),
      observedNow,
      observedThen: undefined,
    });
    const byName = Object.fromEntries(cs.entries.map((e) => [e.name, e.action]));
    expect(byName.MyQueue).toBe("create");
    expect(byName.MyBucket).toBe("adopt");

    // Declared + live with no drift → noop.
    const cs2 = buildChangeSet("prod", {
      declared: new Set(["MyBucket"]),
      observedNow,
      observedThen: undefined,
    });
    expect(cs2.entries.find((e) => e.name === "MyBucket")!.action).toBe("noop");
  });

  // #1647 — the carve state, end to end: terraform applied the bucket, carve
  // emitted a carveout declaring it by BucketName, and no CFN stack has ever
  // heard of it. The stack read alone said confirmed-absent (missing → a plan
  // proposing create for a bucket that EXISTS); the identity fallback asks
  // Cloud Control by the declared identifier and the verdict comes back
  // observed.
  test("identity fallback: a declared, stack-absent, live resource reads observed, not missing (#1647)", async () => {
    const routeBoth = (cc: { status?: number; text: string }): void => {
      vi.spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: { body: string; headers?: Record<string, string> }) => {
        const target = init.headers?.["x-amz-target"] ?? "";
        if (target.endsWith("GetResource")) return { status: cc.status ?? 200, text: () => Promise.resolve(cc.text) };
        const action = new URLSearchParams(init.body).get("Action") ?? "";
        return {
          status: 200,
          text: () => Promise.resolve(action === "DescribeStackResources" ? stackResourcesXml([]) : stackOutputsXml()),
        };
      }) as unknown as typeof fetch);
    };

    const entities = new Map([
      ["assets", { entityType: "AWS::S3::Bucket", props: { BucketName: "acme-platform-assets-prod" } }],
    ]);

    routeBoth({
      text: JSON.stringify({
        ResourceDescription: {
          Identifier: "acme-platform-assets-prod",
          Properties: JSON.stringify({ BucketName: "acme-platform-assets-prod" }),
        },
      }),
    });
    const observed = normalizeObservation(
      await awsPlugin.describeResources!({
        environment: "prod",
        buildOutput: "",
        entityNames: ["assets"],
        entities,
      }),
    );
    expect(observed.resources.assets).toMatchObject({
      type: "AWS::S3::Bucket",
      status: "EXTERNAL",
      ownership: "foreign",
    });
    // #1620: the identity read's address rides the observation.
    expect(observed.queried.assets).toContain("acme-platform-assets-prod");

    // Through the change set: declared + live → noop, never create. `foreign`
    // ownership never escalates anything (#120's rule holds).
    const cs = buildChangeSet("prod", { declared: new Set(["assets"]), observedNow: observed.resources, observedThen: undefined });
    expect(cs.entries.find((e) => e.name === "assets")!.action).toBe("noop");

    // An emulator without Cloud Control keeps today's verdict exactly: absent,
    // create proposed — the fallback must not turn pre-first-apply into a hole.
    routeBoth({ status: 400, text: JSON.stringify({ __type: "UnsupportedOperation", message: "not supported" }) });
    const degraded = normalizeObservation(
      await awsPlugin.describeResources!({
        environment: "prod",
        buildOutput: "",
        entityNames: ["assets"],
        entities,
      }),
    );
    expect(degraded.resources.assets).toBeUndefined();
    expect(degraded.unobserved.assets).toBeUndefined();
    const cs2 = buildChangeSet("prod", { declared: new Set(["assets"]), observedNow: degraded.resources, observedThen: undefined });
    expect(cs2.entries.find((e) => e.name === "assets")!.action).toBe("create");
  });

  describe("describeStackStatus (#57 — per-component stack presence)", () => {
    const err = (stderr: string) => ({ stdout: "", stderr, exitCode: 255 });

    test("present + healthy for a terminal-success stack", async () => {
      spawnMock.mockResolvedValue(ok(JSON.stringify({ Stacks: [{ StackStatus: "CREATE_COMPLETE" }] })));
      const obs = await awsPlugin.describeStackStatus!({ environment: "local", stack: "loom-local-a-loom-db" });
      expect(obs).toEqual({ stack: "loom-local-a-loom-db", present: true, status: "CREATE_COMPLETE", healthy: true });
    });

    test("present but not healthy for a rollback/failed state", async () => {
      spawnMock.mockResolvedValue(ok(JSON.stringify({ Stacks: [{ StackStatus: "ROLLBACK_COMPLETE" }] })));
      const obs = await awsPlugin.describeStackStatus!({ environment: "local", stack: "s" });
      expect(obs).toMatchObject({ present: true, status: "ROLLBACK_COMPLETE", healthy: false });
    });

    test("in-progress is present but not yet healthy", async () => {
      spawnMock.mockResolvedValue(ok(JSON.stringify({ Stacks: [{ StackStatus: "UPDATE_IN_PROGRESS" }] })));
      const obs = await awsPlugin.describeStackStatus!({ environment: "local", stack: "s" });
      expect(obs).toMatchObject({ present: true, healthy: false });
    });

    test("absent (does-not-exist) reports present: false, not an error", async () => {
      spawnMock.mockResolvedValue(err("ValidationError: Stack with id s does not exist"));
      const obs = await awsPlugin.describeStackStatus!({ environment: "local", stack: "s" });
      expect(obs).toEqual({ stack: "s", present: false });
    });

    test("any other CLI failure is indeterminate → null (never a false 'gone')", async () => {
      spawnMock.mockResolvedValue(err("Unable to locate credentials"));
      const obs = await awsPlugin.describeStackStatus!({ environment: "local", stack: "s" });
      expect(obs).toBeNull();
    });
  });

  /**
   * The #1089 chain on the real plugin: a CloudFormation read that fails for
   * any reason other than "stack does not exist" reports every declared entity
   * NOT-OBSERVED, and that survives describe → plan → component status.
   */
  test("tri-state chain: a failed stack read stays unobserved through describe → plan → status (#1089)", async () => {
    stubCfnError("AccessDenied", "Unable to locate credentials");

    const observed = normalizeObservation(
      await awsPlugin.describeResources!({
        environment: "prod",
        buildOutput: "",
        entityNames: ["MyBucket", "MyQueue"],
        entities: new Map(),
      }),
    );
    expect(observed.resources).toEqual({});
    expect(observed.unobserved.MyBucket.reason).toBe("no-credentials");

    const cs = buildChangeSet("prod", {
      declared: new Set(["MyBucket", "MyQueue"]),
      observedNow: observed.resources,
      observedThen: undefined,
      unobserved: observed.unobserved,
    });
    expect(cs.entries.map((e) => e.action)).toEqual(["unobserved", "unobserved"]);

    const rows = reconcileStatus("prod", [
      { component: "MyBucket", env: "prod", digest: "sha256:abc", gitSha: "g", runId: "r", timestamp: "2026-01-01T00:00:00Z", actor: "ci" },
    ], { liveEvidence: liveEvidenceFromChangeSet(cs) });
    expect(rows[0].reconciliation).toBe("unknown");
    expect(rows[0].live).toBeUndefined();
    expect(rows[0].unobserved?.reason).toBe("no-credentials");
  });

  test("a stack that does not exist is a real absence — every declared entity is a create", async () => {
    stubCfnError("ValidationError", "Stack with id prod does not exist");

    const observed = normalizeObservation(
      await awsPlugin.describeResources!({
        environment: "prod",
        buildOutput: "",
        entityNames: ["MyBucket"],
        entities: new Map(),
      }),
    );
    expect(observed.resources).toEqual({});
    expect(observed.unobserved).toEqual({});

    const cs = buildChangeSet("prod", {
      declared: new Set(["MyBucket"]),
      observedNow: observed.resources,
      observedThen: undefined,
      unobserved: observed.unobserved,
    });
    expect(cs.entries[0].action).toBe("create");
  });

  // #1265 — the ownership notice printed once per `describeResources` call, so
  // a four-stack project got four identical copies ahead of every answer. It
  // is a property of the read path, not of a stack: the plugin now returns it
  // as a note on the observation and core says it once per run.
  test("owned read on a four-stack project: one ownership note, nothing printed", async () => {
    stubCfn((action) =>
      action === "DescribeStackResources"
        ? { text: stackResourcesXml([{ logicalId: "MyBucket", type: "AWS::S3::Bucket", physicalId: "my-bucket" }]) }
        : { text: stackOutputsXml() },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const entities = new Map([
      ["MyBucket", { [DECLARABLE_MARKER]: true as const, lexicon: "aws", entityType: "AWS::S3::Bucket", props: {} }],
    ]);
    const result = await observeResources(
      "prod",
      [awsPlugin],
      { errors: [], warnings: [], entities, outputs: new Map([["aws", ""]]) } as never,
      { owned: true, stacks: ["prod-net", "prod-data", "prod-app", "prod-edge"] },
    );
    const ownership = result.notes.filter((n) => n.includes("ownership filter unavailable"));
    expect(ownership).toHaveLength(1);
    expect(ownership[0]).toBe(
      "[aws] ownership filter unavailable on describeResources (no tags from describe-stack-resources) — returning all, each with an explicit `unknown` verdict; use `chant import --from <env> --owned` for ownership-filtered export",
    );
    expect(result.warnings.join("\n")).not.toContain("ownership filter unavailable");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test("an unowned read carries no ownership note", async () => {
    stubCfn((action) =>
      action === "DescribeStackResources"
        ? { text: stackResourcesXml([{ logicalId: "MyBucket", type: "AWS::S3::Bucket", physicalId: "my-bucket" }]) }
        : { text: stackOutputsXml() },
    );
    const observed = normalizeObservation(
      await awsPlugin.describeResources!({ environment: "prod", buildOutput: "", entityNames: ["MyBucket"], entities: new Map() }),
    );
    expect(observed.notes).toEqual([]);
  });
});

// The shared conformance suite (#1089).
describeObservationConformance({
  lexicon: "aws",
  ownershipChannel: awsPlugin.ownershipChannel,
  scenarios: [
    {
      name: "a stack read that fails on credentials",
      declared: ["MyBucket", "MyQueue"],
      expectUnobserved: ["MyBucket", "MyQueue"],
      run: () => {
        stubCfnError("AccessDenied", "Unable to locate credentials");
        return awsPlugin.describeResources!({
          environment: "prod",
          buildOutput: "",
          entityNames: ["MyBucket", "MyQueue"],
          entities: new Map(),
        });
      },
    },
    {
      name: "a stack that does not exist yet",
      declared: ["MyBucket"],
      expectAbsent: ["MyBucket"],
      run: () => {
        stubCfnError("ValidationError", "Stack with id prod does not exist");
        return awsPlugin.describeResources!({
          environment: "prod",
          buildOutput: "",
          entityNames: ["MyBucket"],
          entities: new Map(),
        });
      },
    },
    {
      name: "a healthy stack read",
      declared: ["MyBucket"],
      expectPresent: ["MyBucket"],
      run: () => {
        stubCfn((action) =>
          action === "DescribeStackResources"
            ? { text: stackResourcesXml([{ logicalId: "MyBucket", type: "AWS::S3::Bucket", physicalId: "my-bucket" }]) }
            : { text: stackOutputsXml() },
        );
        return awsPlugin.describeResources!({
          environment: "prod",
          buildOutput: "",
          entityNames: ["MyBucket"],
          entities: new Map(),
        });
      },
    },
    {
      // aws declares a marker channel on the deep read and on live export, but
      // not here: describe-stack-resources returns no tags, so the filter has
      // nothing to filter on. The suite holds it to that — an `owned` verdict
      // from this path would be a claim the transport cannot support (#1348).
      name: "an owned read on a path with no marker channel",
      declared: ["MyBucket"],
      expectPresent: ["MyBucket"],
      owned: true,
      run: () => {
        stubCfn((action) =>
          action === "DescribeStackResources"
            ? { text: stackResourcesXml([{ logicalId: "MyBucket", type: "AWS::S3::Bucket", physicalId: "my-bucket" }]) }
            : { text: stackOutputsXml() },
        );
        return awsPlugin.describeResources!({
          environment: "prod",
          buildOutput: "",
          entityNames: ["MyBucket"],
          entities: new Map(),
          owned: true,
        });
      },
    },
  ],
});
