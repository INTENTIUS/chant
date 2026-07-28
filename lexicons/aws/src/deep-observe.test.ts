/**
 * AWS deep observation (#1015) — the reference row of the deep-observe contract
 * (#1014).
 *
 * Every AWS interaction here is a mocked `spawn`. Nothing constructs a client,
 * reads ambient credentials, or reaches a network: the reader's only edge is
 * the runtime adapter, and it is replaced wholesale below.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

// Partial mock (`importOriginal`) for the same reason lifecycle-integration.test.ts
// uses one: this module is reachable from other real exports the plugin path
// touches, so replacing it wholesale breaks things unrelated to `spawn`.
const spawnMock = vi.fn();
vi.mock("@intentius/chant/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@intentius/chant/runtime-adapter")>();
  return { ...actual, getRuntime: () => ({ ...actual.getRuntime(), spawn: spawnMock }) };
});

const { awsPlugin } = await import("./plugin");
const {
  observeResourcesDeepAws,
  awsDeepNormalizationHooks,
  parseCloudControlResource,
  hasOwnershipMarker,
} = await import("./deep-observe");
const { deepDiffForLexicon } = await import("@intentius/chant/lifecycle/deep-observe");
const { normalizeDeepObservation, normalizeDeepProperties } = await import("@intentius/chant/deep-observation");

const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr: string) => ({ stdout: "", stderr, exitCode: 255 });

/** A `cloudcontrol get-resource` envelope — the model arrives as a JSON string. */
const cloudControl = (identifier: string, properties: Record<string, unknown>) =>
  ok(JSON.stringify({ ResourceDescription: { Identifier: identifier, Properties: JSON.stringify(properties) } }));

const stackResources = (rows: Array<[string, string, string]>) =>
  ok(
    JSON.stringify({
      StackResources: rows.map(([LogicalResourceId, ResourceType, PhysicalResourceId]) => ({
        LogicalResourceId,
        ResourceType,
        PhysicalResourceId,
        ResourceStatus: "CREATE_COMPLETE",
        Timestamp: "2026-01-01T00:00:00Z",
      })),
    }),
  );

const entities = (
  record: Record<string, { entityType: string; props: Record<string, unknown> }>,
): Map<string, { entityType: string; props: Record<string, unknown> }> => new Map(Object.entries(record));

const argvOf = (call: unknown[]): string[] => call[0] as string[];

describe("parseCloudControlResource", () => {
  test("unwraps the doubly-encoded model", () => {
    expect(parseCloudControlResource(cloudControl("b", { BucketName: "b" }).stdout)).toEqual({
      identifier: "b",
      properties: { BucketName: "b" },
    });
  });

  test("an unparseable body is a failed read, not an empty resource", () => {
    expect(parseCloudControlResource("not json")).toBeNull();
    expect(parseCloudControlResource(JSON.stringify({ ResourceDescription: {} }))).toBeNull();
    expect(
      parseCloudControlResource(JSON.stringify({ ResourceDescription: { Properties: "{oops" } })),
    ).toBeNull();
  });
});

describe("the aws noise rules", () => {
  test("prunes server-populated names wherever they appear", () => {
    const out = normalizeDeepProperties(
      { Arn: "arn:aws:s3:::b", BucketName: "b", Nested: { RegionalDomainName: "x", Keep: 1 } },
      { entityType: "AWS::S3::Bucket", side: "live", hooks: awsDeepNormalizationHooks },
    );
    expect(out).toEqual({ BucketName: "b", Nested: { Keep: 1 } });
  });

  test("canonicalizes tag order", () => {
    const out = normalizeDeepProperties(
      { Tags: [{ Key: "team", Value: "b" }, { Key: "env", Value: "a" }] },
      { entityType: "AWS::S3::Bucket", side: "live", hooks: awsDeepNormalizationHooks },
    );
    expect(out.Tags).toEqual([{ Key: "env", Value: "a" }, { Key: "team", Value: "b" }]);
  });

  test("canonicalizes policy statement and action order", () => {
    const out = normalizeDeepProperties(
      {
        PolicyDocument: {
          Statement: [
            { Sid: "Write", Action: ["s3:PutObject", "s3:DeleteObject"] },
            { Sid: "Read", Action: ["s3:GetObject"] },
          ],
        },
      },
      { entityType: "AWS::IAM::ManagedPolicy", side: "live", hooks: awsDeepNormalizationHooks },
    );
    const statements = (out.PolicyDocument as { Statement: Array<{ Sid: string; Action: string[] }> }).Statement;
    expect(statements.map((s) => s.Sid)).toEqual(["Read", "Write"]);
    expect(statements[1].Action).toEqual(["s3:DeleteObject", "s3:PutObject"]);
  });

  test("subtracts a service default only where source is silent about the property", () => {
    const declaredNothing = normalizeDeepProperties(
      { Path: "/", MaxSessionDuration: 3600, RoleName: "r" },
      {
        entityType: "AWS::IAM::Role",
        side: "live",
        hooks: awsDeepNormalizationHooks,
        counterpartPaths: new Set(["RoleName"]),
      },
    );
    expect(declaredNothing).toEqual({ RoleName: "r" });

    const declaredPath = normalizeDeepProperties(
      { Path: "/", RoleName: "r" },
      {
        entityType: "AWS::IAM::Role",
        side: "live",
        hooks: awsDeepNormalizationHooks,
        counterpartPaths: new Set(["Path", "RoleName"]),
      },
    );
    expect(declaredPath).toEqual({ Path: "/", RoleName: "r" });
  });

  test("a one-sided pass never subtracts defaults — the reader has no declared tree yet", () => {
    const out = normalizeDeepProperties(
      { Path: "/", RoleName: "r" },
      { entityType: "AWS::IAM::Role", side: "live", hooks: awsDeepNormalizationHooks },
    );
    expect(out).toEqual({ Path: "/", RoleName: "r" });
  });
});

describe("hasOwnershipMarker", () => {
  test("reads chant's tag out of the live tree", () => {
    expect(hasOwnershipMarker({ Tags: [{ Key: "chant:managed-by", Value: "chant" }] })).toBe(true);
    expect(hasOwnershipMarker({ Tags: [{ Key: "env", Value: "prod" }] })).toBe(false);
    expect(hasOwnershipMarker({})).toBe(false);
  });
});

describe("observeResourcesDeepAws", () => {
  beforeEach(() => {
    // A bare arrow returning the mock would register the mock itself as
    // vitest's cleanup hook, and vitest would then call it with no arguments.
    spawnMock.mockReset();
  });

  test("reads each resource through cloudcontrol, honoring AWS_ENDPOINT_URL", async () => {
    const previous = process.env.AWS_ENDPOINT_URL;
    process.env.AWS_ENDPOINT_URL = "http://127.0.0.1:5566";
    try {
      spawnMock.mockImplementation((argv: string[]) =>
        Promise.resolve(
          argv.includes("describe-stack-resources")
            ? stackResources([["Assets", "AWS::S3::Bucket", "acme-assets"]])
            : cloudControl("acme-assets", { BucketName: "acme-assets" }),
        ),
      );
      const result = normalizeDeepObservation(
        await observeResourcesDeepAws({ environment: "prod", entityNames: ["Assets"] }),
      );
      expect(result.resources.Assets.properties).toEqual({ BucketName: "acme-assets" });
      expect(result.resources.Assets.physicalId).toBe("acme-assets");
      for (const call of spawnMock.mock.calls) {
        expect(argvOf(call)).toContain("--endpoint-url");
        expect(argvOf(call)).toContain("http://127.0.0.1:5566");
      }
    } finally {
      if (previous === undefined) delete process.env.AWS_ENDPOINT_URL;
      else process.env.AWS_ENDPOINT_URL = previous;
    }
  });

  test("a type with no reader is unsupported-kind, never absent", async () => {
    spawnMock.mockResolvedValue(stackResources([["Queue", "AWS::SQS::Queue", "q-1"]]));
    const result = normalizeDeepObservation(
      await observeResourcesDeepAws({ environment: "prod", entityNames: ["Queue"] }),
    );
    expect(result.resources).toEqual({});
    expect(result.unobserved.Queue.reason).toBe("unsupported-kind");
  });

  test("an expired token on the deep read is no-credentials, per resource", async () => {
    spawnMock.mockImplementation((argv: string[]) =>
      Promise.resolve(
        argv.includes("describe-stack-resources")
          ? stackResources([["Assets", "AWS::S3::Bucket", "acme-assets"]])
          : fail("An error occurred (ExpiredToken) when calling GetResource: The security token expired"),
      ),
    );
    const result = normalizeDeepObservation(
      await observeResourcesDeepAws({ environment: "prod", entityNames: ["Assets"] }),
    );
    expect(result.unobserved.Assets.reason).toBe("no-credentials");
    expect(result.resources).toEqual({});
  });

  test("a stack that does not exist yet is a real absence — no properties, no holes", async () => {
    spawnMock.mockResolvedValue(fail("An error occurred (ValidationError): Stack with id prod does not exist"));
    const result = normalizeDeepObservation(
      await observeResourcesDeepAws({ environment: "prod", entityNames: ["Assets"] }),
    );
    expect(result).toEqual({ resources: {}, unobserved: {} });
  });

  test("any other stack-read failure is a hole for every declared entity", async () => {
    spawnMock.mockResolvedValue(fail("Could not connect to the endpoint URL"));
    const result = normalizeDeepObservation(
      await observeResourcesDeepAws({ environment: "prod", entityNames: ["A", "B"] }),
    );
    expect(Object.keys(result.unobserved)).toEqual(["A", "B"]);
    expect(result.unobserved.A.reason).toBe("read-failed");
  });

  test("--owned withholds an unmarked resource as `filtered`, not as absent", async () => {
    spawnMock.mockImplementation((argv: string[]) =>
      Promise.resolve(
        argv.includes("describe-stack-resources")
          ? stackResources([
              ["Ours", "AWS::S3::Bucket", "ours"],
              ["Theirs", "AWS::S3::Bucket", "theirs"],
            ])
          : argv.includes("ours")
            ? cloudControl("ours", { BucketName: "ours", Tags: [{ Key: "chant:managed-by", Value: "chant" }] })
            : cloudControl("theirs", { BucketName: "theirs" }),
      ),
    );
    const result = normalizeDeepObservation(
      await observeResourcesDeepAws({ environment: "prod", entityNames: ["Ours", "Theirs"], owned: true }),
    );
    expect(Object.keys(result.resources)).toEqual(["Ours"]);
    expect(result.unobserved.Theirs.reason).toBe("filtered");
  });

  test("secret-bearing properties are masked before they reach the tree", async () => {
    spawnMock.mockImplementation((argv: string[]) =>
      Promise.resolve(
        argv.includes("describe-stack-resources")
          ? stackResources([["Role", "AWS::IAM::Role", "app-role"]])
          : cloudControl("app-role", { RoleName: "app-role", ClientSecret: "s3cr3t" }),
      ),
    );
    const result = normalizeDeepObservation(
      await observeResourcesDeepAws({ environment: "prod", entityNames: ["Role"] }),
    );
    expect(result.resources.Role.properties.ClientSecret).toBe("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain("s3cr3t");
  });

  test("a multi-stack project reads the stack it was handed", async () => {
    spawnMock.mockResolvedValue(stackResources([]));
    await observeResourcesDeepAws({ environment: "prod", entityNames: ["A"], stack: "payments-prod" });
    expect(argvOf(spawnMock.mock.calls[0])).toContain("payments-prod");
  });
});

/**
 * The acceptance test for #1015: the real plugin, a mutated live tree, a
 * baseline, and exactly the genuine drift.
 */
describe("end to end: declared + mutated live + baseline (#1015)", () => {
  beforeEach(() => {
    // A bare arrow returning the mock would register the mock itself as
    // vitest's cleanup hook, and vitest would then call it with no arguments.
    spawnMock.mockReset();
  });

  const declared = entities({
    // Declared with two tags and versioning on.
    Assets: {
      entityType: "AWS::S3::Bucket",
      props: {
        BucketName: "acme-assets",
        VersioningConfiguration: { Status: "Enabled" },
        Tags: [
          { Key: "env", Value: "prod" },
          { Key: "team", Value: "payments" },
        ],
      },
    },
    // Declared with two statements, in source order.
    AppRole: {
      entityType: "AWS::IAM::Role",
      props: {
        RoleName: "app-role",
        AssumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            { Sid: "Ec2", Effect: "Allow", Action: ["sts:AssumeRole"] },
            { Sid: "Ci", Effect: "Allow", Action: ["sts:AssumeRole", "sts:TagSession"] },
          ],
        },
      },
    },
    // No Cloud Control reader for this type.
    Jobs: { entityType: "AWS::SQS::Queue", props: { QueueName: "jobs" } },
    // The deep read of this one fails outright.
    Perimeter: { entityType: "AWS::EC2::SecurityGroup", props: { GroupDescription: "perimeter" } },
  });

  const wireMocks = (): void => {
    spawnMock.mockImplementation((argv: string[]) => {
      if (argv.includes("describe-stack-resources")) {
        return Promise.resolve(
          stackResources([
            ["Assets", "AWS::S3::Bucket", "acme-assets"],
            ["AppRole", "AWS::IAM::Role", "app-role"],
            ["Jobs", "AWS::SQS::Queue", "jobs"],
            ["Perimeter", "AWS::EC2::SecurityGroup", "sg-01"],
          ]),
        );
      }
      if (argv.includes("acme-assets")) {
        return Promise.resolve(
          cloudControl("acme-assets", {
            BucketName: "acme-assets",
            // GENUINE: somebody turned versioning off in the console.
            VersioningConfiguration: { Status: "Suspended" },
            // NOISE: tags come back in a different order …
            Tags: [
              { Key: "team", Value: "payments" },
              // … and with one the platform team adds to every bucket.
              { Key: "cost-center", Value: "platform" },
              { Key: "env", Value: "prod" },
            ],
            // NOISE: server-populated.
            Arn: "arn:aws:s3:::acme-assets",
            RegionalDomainName: "acme-assets.s3.us-east-1.amazonaws.com",
          }),
        );
      }
      if (argv.includes("app-role")) {
        return Promise.resolve(
          cloudControl("app-role", {
            RoleName: "app-role",
            // NOISE: statements and actions in a different order than source.
            AssumeRolePolicyDocument: {
              Version: "2012-10-17",
              Statement: [
                { Sid: "Ci", Effect: "Allow", Action: ["sts:TagSession", "sts:AssumeRole"] },
                { Sid: "Ec2", Effect: "Allow", Action: ["sts:AssumeRole"] },
              ],
            },
            // NOISE: provider defaults nobody declared.
            Path: "/",
            MaxSessionDuration: 3600,
            // NOISE: server-populated.
            Arn: "arn:aws:iam::111122223333:role/app-role",
            RoleId: "AROAEXAMPLE",
            CreateDate: "2026-01-01T00:00:00Z",
          }),
        );
      }
      if (argv.includes("sg-01")) {
        return Promise.resolve(fail("An error occurred (ThrottlingException) when calling GetResource"));
      }
      return Promise.resolve(fail("unexpected call"));
    });
  };

  const baseline = {
    Assets: {
      type: "AWS::S3::Bucket",
      accepted: [
        { path: "Tags[#cost-center].Key", value: "cost-center" },
        { path: "Tags[#cost-center].Value", value: "platform" },
      ],
    },
  };

  test("exactly the genuine drift surfaces; noise, defaults and the accepted tag do not", async () => {
    wireMocks();
    const result = await deepDiffForLexicon(awsPlugin, {
      environment: "prod",
      buildOutput: "",
      entities: declared,
      baseline,
    });

    // One finding, one property: the console-flipped versioning setting.
    expect(result.drifted).toEqual([
      {
        name: "Assets",
        type: "AWS::S3::Bucket",
        changes: [
          {
            path: "VersioningConfiguration.Status",
            kind: "changed",
            declared: "Enabled",
            live: "Suspended",
          },
        ],
      },
    ]);

    // The role is clean: reordering, defaults and server-populated fields are
    // all subtracted.
    expect(result.unchanged).toEqual(["AppRole"]);

    // The platform team's tag is accepted, so it is reported as suppressed
    // rather than as drift.
    expect(result.accepted.map((e) => e.name)).toEqual(["Assets"]);
    expect(result.accepted[0].changes.map((c) => c.path)).toEqual([
      "Tags[#cost-center].Key",
      "Tags[#cost-center].Value",
    ]);

    // An unreadable deep read is a hole with a reason — never silence, never
    // noise, and never a create.
    expect(result.unobserved).toEqual([
      {
        name: "Jobs",
        type: "AWS::SQS::Queue",
        reason: "unsupported-kind",
        detail: "no deep reader for AWS::SQS::Queue — Cloud Control coverage is opt-in per type",
      },
      {
        name: "Perimeter",
        type: "AWS::EC2::SecurityGroup",
        reason: "read-failed",
        detail:
          'cloudcontrol get-resource failed for AWS::EC2::SecurityGroup "sg-01": An error occurred (ThrottlingException) when calling GetResource',
      },
    ]);
  });

  test("without the baseline the platform tag is drift, and accepting it is what silences it", async () => {
    wireMocks();
    const result = await deepDiffForLexicon(awsPlugin, {
      environment: "prod",
      buildOutput: "",
      entities: declared,
    });
    const assets = result.drifted.find((d) => d.name === "Assets");
    expect(assets?.changes.map((c) => c.path).sort()).toEqual([
      "Tags[#cost-center].Key",
      "Tags[#cost-center].Value",
      "VersioningConfiguration.Status",
    ]);
    expect(result.accepted).toEqual([]);
  });

  test("an accepted value that later changes is drift again, with all three axes", async () => {
    wireMocks();
    const result = await deepDiffForLexicon(awsPlugin, {
      environment: "prod",
      buildOutput: "",
      entities: declared,
      baseline: {
        Assets: {
          accepted: [{ path: "Tags[#cost-center].Value", value: "someone-elses-team" }],
        },
      },
    });
    const change = result.drifted
      .find((d) => d.name === "Assets")
      ?.changes.find((c) => c.path === "Tags[#cost-center].Value");
    expect(change).toEqual({
      path: "Tags[#cost-center].Value",
      kind: "undeclared",
      live: "platform",
      baseline: "someone-elses-team",
    });
  });

  test("a whole-lexicon failure is a hole for every declared entity, not a clean report", async () => {
    spawnMock.mockResolvedValue(fail("Unable to locate credentials"));
    const result = await deepDiffForLexicon(awsPlugin, {
      environment: "prod",
      buildOutput: "",
      entities: declared,
    });
    expect(result.drifted).toEqual([]);
    expect(result.unobserved.map((u) => u.name).sort()).toEqual(["AppRole", "Assets", "Jobs", "Perimeter"]);
    expect(new Set(result.unobserved.map((u) => u.reason))).toEqual(new Set(["no-credentials"]));
  });
});
