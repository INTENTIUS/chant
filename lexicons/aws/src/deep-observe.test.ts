/**
 * AWS deep observation (#1015) — the reference row of the deep-observe contract
 * (#1014).
 *
 * Every AWS interaction here is a faked HTTP call (#1206). Nothing spawns a
 * CLI, reads ambient credentials, or reaches a network: the reader's only edge
 * is its transport, which is injected as `http` where the reader is called
 * directly and stubbed at `fetch` where the plugin builds its own.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// The Cloud Control source is injected as `http`; the EC2 source still shells
// the CLI (#1269), so that one edge is mocked here. Partial mock for the same
// reason lifecycle-integration.test.ts uses one — this module is reachable from
// real exports the plugin path touches.
const spawnMock = vi.fn();
vi.mock("@intentius/chant/runtime-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@intentius/chant/runtime-adapter")>();
  return { ...actual, getRuntime: () => ({ ...actual.getRuntime(), spawn: spawnMock }) };
});

const { awsPlugin } = await import("./plugin");
const {
  observeResourcesDeepAws,
  awsDeepNormalizationHooks,
  hasOwnershipMarker,
  schemaReadOnlyPatterns,
} = await import("./deep-observe");
const { parseResourceDescription } = await import("./api/read-client");
const { deepDiffForLexicon } = await import("@intentius/chant/lifecycle/deep-observe");
const { normalizeDeepObservation, normalizeDeepProperties, flattenDeepProperties } = await import("@intentius/chant/deep-observation");

const ok = (text: string) => ({ status: 200, text });

/** A Cloud Control `GetResource` body — the model arrives as a JSON string. */
const cloudControl = (identifier: string, properties: Record<string, unknown>) =>
  ok(JSON.stringify({ ResourceDescription: { Identifier: identifier, Properties: JSON.stringify(properties) } }));

/** A modelled service error, in the shape AWS JSON 1.0 sends it. */
const apiError = (type: string, message: string, status = 400) =>
  ({ status, text: JSON.stringify({ __type: type, message }) });

/** A CloudFormation Query `<Error>` document. */
const queryError = (code: string, message: string) =>
  ({ status: 400, text: `<ErrorResponse><Error><Code>${code}</Code><Message>${message}</Message></Error></ErrorResponse>` });

const stackResources = (rows: Array<[string, string, string]>) =>
  ok(
    `<DescribeStackResourcesResponse><DescribeStackResourcesResult><StackResources>${rows
      .map(
        ([logicalId, type, physicalId]) =>
          `<member><LogicalResourceId>${logicalId}</LogicalResourceId><ResourceType>${type}</ResourceType>` +
          `<PhysicalResourceId>${physicalId}</PhysicalResourceId><ResourceStatus>CREATE_COMPLETE</ResourceStatus>` +
          `<Timestamp>2026-01-01T00:00:00Z</Timestamp></member>`,
      )
      .join("")}</StackResources></DescribeStackResourcesResult></DescribeStackResourcesResponse>`,
  );

type FakeResponse = { status: number; text: string };
interface FakeCall {
  url: string;
  target?: string;
  body: string;
}

/**
 * A transport fake in place of the old `spawn` fake. `route` sees the Cloud
 * Control identifier (or `undefined` for the CloudFormation call) and returns
 * the response; every call is recorded so a test can assert the endpoint the
 * reader actually reached.
 */
function httpFake(route: (identifier: string | undefined, call: FakeCall) => FakeResponse) {
  const calls: FakeCall[] = [];
  const http = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    const target = init.headers["x-amz-target"];
    const call: FakeCall = { url, ...(target ? { target } : {}), body: init.body };
    calls.push(call);
    const identifier = target ? (JSON.parse(init.body) as { Identifier?: string }).Identifier : undefined;
    return route(identifier, call);
  };
  return { http, calls };
}

const entities = (
  record: Record<string, { entityType: string; props: Record<string, unknown> }>,
): Map<string, { entityType: string; props: Record<string, unknown> }> => new Map(Object.entries(record));


describe("parseResourceDescription", () => {
  test("unwraps the doubly-encoded model", () => {
    expect(parseResourceDescription({ Identifier: "b", Properties: JSON.stringify({ BucketName: "b" }) })).toEqual({
      identifier: "b",
      properties: { BucketName: "b" },
    });
  });

  test("an unparseable body is a failed read, not an empty resource", () => {
    expect(parseResourceDescription("not an object")).toBeNull();
    expect(parseResourceDescription({})).toBeNull();
    expect(parseResourceDescription({ Properties: "{oops" })).toBeNull();
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

  // chant stamps its ownership marker onto the template, so it is live on every
  // managed resource and absent from the declared properties the diff compares.
  // Reporting it is chant reading its own signature back as drift.
  test("chant's own ownership tags are not drift", () => {
    const out = normalizeDeepProperties(
      {
        Tags: [
          { Key: "chant:managed-by", Value: "chant" },
          { Key: "chant:stack", Value: "web" },
          { Key: "chant:env", Value: "prod" },
          { Key: "team", Value: "payments" },
        ],
      },
      {
        entityType: "AWS::EC2::SecurityGroup",
        side: "live",
        hooks: awsDeepNormalizationHooks,
        counterpartPaths: new Set<string>(),
      },
    );
    expect(out.Tags).toEqual([{ Key: "team", Value: "payments" }]);
  });

  test("a template that declares the marker itself still has it compared", () => {
    const out = normalizeDeepProperties(
      { Tags: [{ Key: "chant:stack", Value: "renamed" }] },
      {
        entityType: "AWS::EC2::SecurityGroup",
        side: "live",
        hooks: awsDeepNormalizationHooks,
        // Source declares the tag, so the counterpart is present and the
        // suppression must not apply — a changed value is real drift.
        counterpartPaths: new Set(["Tags[].Key", "Tags[].Value", "Tags[0]"]),
      },
    );
    expect(out.Tags).toEqual([{ Key: "chant:stack", Value: "renamed" }]);
  });

  // A rule's canonical JSON is longer than a path segment may carry, so keying
  // by it made the flattener compare rule sets positionally — one added rule
  // then reported as "the first rule changed, and a new one appeared".
  test("keys a security-group rule by protocol, ports and source", () => {
    const out = flattenDeepProperties(
      {
        SecurityGroupIngress: [
          { IpProtocol: "tcp", FromPort: 22, ToPort: 22, CidrIp: "203.0.113.0/24", Description: "ssh from the office" },
          { IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIp: "0.0.0.0/0" },
        ],
      },
      { entityType: "AWS::EC2::SecurityGroup", side: "live", hooks: awsDeepNormalizationHooks },
    );
    const paths = [...out.keys()];
    expect(paths).toContain("SecurityGroupIngress[#tcp:22:22:203.0.113.0/24].CidrIp");
    expect(paths).toContain("SecurityGroupIngress[#tcp:443:443:0.0.0.0/0].CidrIp");
    // Positional segments would mean the set is being compared by position.
    expect(paths.some((p) => p.startsWith("SecurityGroupIngress[0]"))).toBe(false);
  });

  test("a rule keeps its identity when only its description changes", () => {
    const key = (description: string) =>
      [
        ...flattenDeepProperties(
          { SecurityGroupIngress: [{ IpProtocol: "tcp", FromPort: 22, ToPort: 22, CidrIp: "10.0.0.0/8", Description: description }] },
          { entityType: "AWS::EC2::SecurityGroup", side: "live", hooks: awsDeepNormalizationHooks },
        ).keys(),
      ].filter((p) => p.endsWith(".CidrIp"));
    // Editing a description is a change to that rule, not a delete plus an add.
    expect(key("before")).toEqual(key("after"));
  });

  test("a rule with no recognisable source falls back rather than colliding", () => {
    const out = flattenDeepProperties(
      {
        SecurityGroupIngress: [
          { IpProtocol: "tcp", FromPort: 1, ToPort: 1 },
          { IpProtocol: "udp", FromPort: 2, ToPort: 2 },
        ],
      },
      { entityType: "AWS::EC2::SecurityGroup", side: "live", hooks: awsDeepNormalizationHooks },
    );
    // Two sourceless rules must not key to the same segment; canonical JSON
    // still distinguishes them.
    expect([...out.keys()].filter((p) => p.endsWith(".IpProtocol"))).toHaveLength(2);
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

// A property the schema marks read-only is a GetAtt attribute, never a
// declared input. The live read still reports it, so without the schema-driven
// rule every clean apply shows `<undeclared> -> value` for it.
describe("schema read-only properties are attributes, not drift (#1641)", () => {
  test("the registry is read off the schema's readOnlyProperties, arrays spelled as patterns", () => {
    expect([...schemaReadOnlyPatterns("AWS::IAM::ManagedPolicy")]).toEqual(
      expect.arrayContaining(["PolicyArn", "PolicyId", "AttachmentCount", "DefaultVersionId"]),
    );
    expect([...schemaReadOnlyPatterns("AWS::RDS::DBInstance")]).toEqual(
      expect.arrayContaining(["Endpoint.Address", "Endpoint.Port", "DbiResourceId", "DBInstanceStatus"]),
    );
    expect([...schemaReadOnlyPatterns("AWS::CE::AnomalySubscription")]).toContain("Subscribers[].Status");
    expect(schemaReadOnlyPatterns("AWS::Made::Up").size).toBe(0);
  });

  test("ManagedPolicy: a live read carrying PolicyArn is not property drift", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      const target = init.headers["x-amz-target"];
      if (!target) return { status: 200, text: () => Promise.resolve(stackResources([["ReadOnly", "AWS::IAM::ManagedPolicy", "arn:aws:iam::000000000000:policy/S3VectorsReadOnlyAccess"]]).text) };
      const r = cloudControl("arn:aws:iam::000000000000:policy/S3VectorsReadOnlyAccess", {
        ManagedPolicyName: "S3VectorsReadOnlyAccess",
        Path: "/",
        PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3vectors:Get*"], Resource: "*" }] },
        // Every readOnlyProperties entry for the type, as real AWS and the
        // emulator return them. PolicyArn is also the primary identifier.
        PolicyArn: "arn:aws:iam::000000000000:policy/S3VectorsReadOnlyAccess",
        PolicyId: "ANPA000000000000EXAMPLE",
        AttachmentCount: 1,
        DefaultVersionId: "v1",
        IsAttachable: true,
        PermissionsBoundaryUsageCount: 0,
        CreateDate: "2026-01-01T00:00:00Z",
        UpdateDate: "2026-01-01T00:00:00Z",
      });
      return { status: r.status, text: () => Promise.resolve(r.text) };
    }) as unknown as typeof fetch);
    try {
      const result = await deepDiffForLexicon(awsPlugin, {
        environment: "prod",
        buildOutput: "",
        entities: entities({
          ReadOnly: {
            entityType: "AWS::IAM::ManagedPolicy",
            props: {
              ManagedPolicyName: "S3VectorsReadOnlyAccess",
              PolicyDocument: { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: ["s3vectors:Get*"], Resource: "*" }] },
            },
          },
        }),
      });
      expect(result.drifted).toEqual([]);
      expect(result.unchanged).toEqual(["ReadOnly"]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  test("a second type with nested read-only paths: RDS DBInstance's endpoint and status are pruned, inputs are kept", () => {
    const out = normalizeDeepProperties(
      {
        DBInstanceIdentifier: "db-1",
        DBInstanceClass: "db.t4g.micro",
        Endpoint: { Address: "db-1.abc.us-east-1.rds.amazonaws.com", Port: "5432", HostedZoneId: "Z1" },
        DbiResourceId: "db-ABCDEF",
        DBInstanceStatus: "available",
        InstanceCreateTime: "2026-01-01T00:00:00Z",
        CertificateDetails: { CAIdentifier: "rds-ca-rsa2048-g1", ValidTill: "2027-01-01T00:00:00Z" },
        ProcessorFeatures: [{ Name: "coreCount", Value: "2" }],
      },
      { entityType: "AWS::RDS::DBInstance", side: "live", hooks: awsDeepNormalizationHooks },
    );
    expect(out).toEqual({
      DBInstanceIdentifier: "db-1",
      DBInstanceClass: "db.t4g.micro",
      ProcessorFeatures: [{ Name: "coreCount", Value: "2" }],
    });
  });

  test("an array element path from the schema prunes inside the array", () => {
    const out = normalizeDeepProperties(
      {
        SubscriptionName: "spend",
        Subscribers: [{ Address: "a@example.com", Type: "EMAIL", Status: "CONFIRMED" }],
      },
      { entityType: "AWS::CE::AnomalySubscription", side: "live", hooks: awsDeepNormalizationHooks },
    );
    expect(out).toEqual({
      SubscriptionName: "spend",
      Subscribers: [{ Address: "a@example.com", Type: "EMAIL" }],
    });
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
  beforeEach(() => spawnMock.mockReset());

  test("reads each resource through Cloud Control, honoring AWS_ENDPOINT_URL", async () => {
    const previous = process.env.AWS_ENDPOINT_URL;
    process.env.AWS_ENDPOINT_URL = "http://127.0.0.1:5566";
    try {
      const fake = httpFake((identifier) =>
        identifier === undefined
          ? stackResources([["Assets", "AWS::S3::Bucket", "acme-assets"]])
          : cloudControl("acme-assets", { BucketName: "acme-assets" }),
      );
      const result = normalizeDeepObservation(
        await observeResourcesDeepAws({ environment: "prod", entityNames: ["Assets"], http: fake.http }),
      );
      expect(result.resources.Assets.properties).toEqual({ BucketName: "acme-assets" });
      expect(result.resources.Assets.physicalId).toBe("acme-assets");
      // The endpoint override reaches both APIs — no `--endpoint-url` argv to
      // forget, because there is no argv.
      for (const call of fake.calls) expect(call.url).toBe("http://127.0.0.1:5566/");
      expect(fake.calls.map((c) => c.target)).toEqual([undefined, "CloudApiService.GetResource"]);
    } finally {
      if (previous === undefined) delete process.env.AWS_ENDPOINT_URL;
      else process.env.AWS_ENDPOINT_URL = previous;
    }
  });

  test("a type with no reader is unsupported-kind, never absent", async () => {
    const fake = httpFake(() => stackResources([["Queue", "AWS::SQS::Queue", "q-1"]]));
    const result = normalizeDeepObservation(
      await observeResourcesDeepAws({ environment: "prod", entityNames: ["Queue"], http: fake.http }),
    );
    expect(result.resources).toEqual({});
    expect(result.unobserved.Queue.reason).toBe("unsupported-kind");
  });

  test("an expired token on the deep read is no-credentials, per resource", async () => {
    const fake = httpFake((identifier) =>
      identifier === undefined
        ? stackResources([["Assets", "AWS::S3::Bucket", "acme-assets"]])
        : apiError("ExpiredTokenException", "The security token included in the request is expired"),
    );
    const result = normalizeDeepObservation(
      await observeResourcesDeepAws({ environment: "prod", entityNames: ["Assets"], http: fake.http }),
    );
    expect(result.unobserved.Assets.reason).toBe("no-credentials");
    expect(result.resources).toEqual({});
  });

  test("an unsupported operation is a hole for that resource, and says which operation", async () => {
    // What Floci answers for GetResource today: the service is reachable and
    // refuses the call, which is neither absence nor a credential problem.
    const fake = httpFake((identifier) =>
      identifier === undefined
        ? stackResources([["Assets", "AWS::S3::Bucket", "acme-assets"]])
        : apiError("UnsupportedOperation", "Operation GetResource is not supported."),
    );
    const result = normalizeDeepObservation(
      await observeResourcesDeepAws({ environment: "prod", entityNames: ["Assets"], http: fake.http }),
    );
    expect(result.unobserved.Assets.reason).toBe("read-failed");
    expect(result.unobserved.Assets.detail).toContain("UnsupportedOperation");
    expect(result.unobserved.Assets.detail).toContain("GetResource");
  });

  test("a stack that does not exist yet is a real absence — no properties, no holes", async () => {
    const fake = httpFake(() => queryError("ValidationError", "Stack with id prod does not exist"));
    const result = normalizeDeepObservation(
      await observeResourcesDeepAws({ environment: "prod", entityNames: ["Assets"], http: fake.http }),
    );
    expect(result).toEqual({ resources: {}, unobserved: {} });
  });

  test("any other stack-read failure is a hole for every declared entity", async () => {
    const fake = httpFake(() => ({ status: 503, text: "<html>service unavailable</html>" }));
    const result = normalizeDeepObservation(
      await observeResourcesDeepAws({ environment: "prod", entityNames: ["A", "B"], http: fake.http }),
    );
    expect(Object.keys(result.unobserved)).toEqual(["A", "B"]);
    expect(result.unobserved.A.reason).toBe("read-failed");
  });

  test("--owned withholds an unmarked resource as `filtered`, not as absent", async () => {
    const fake = httpFake((identifier) =>
      identifier === undefined
        ? stackResources([
            ["Ours", "AWS::S3::Bucket", "ours"],
            ["Theirs", "AWS::S3::Bucket", "theirs"],
          ])
        : identifier === "ours"
          ? cloudControl("ours", { BucketName: "ours", Tags: [{ Key: "chant:managed-by", Value: "chant" }] })
          : cloudControl("theirs", { BucketName: "theirs" }),
    );
    const result = normalizeDeepObservation(
      await observeResourcesDeepAws({ environment: "prod", entityNames: ["Ours", "Theirs"], owned: true, http: fake.http }),
    );
    expect(Object.keys(result.resources)).toEqual(["Ours"]);
    expect(result.unobserved.Theirs.reason).toBe("filtered");
  });

  test("secret-bearing properties are masked before they reach the tree", async () => {
    const fake = httpFake((identifier) =>
      identifier === undefined
        ? stackResources([["Role", "AWS::IAM::Role", "app-role"]])
        : cloudControl("app-role", { RoleName: "app-role", ClientSecret: "s3cr3t" }),
    );
    const result = normalizeDeepObservation(
      await observeResourcesDeepAws({ environment: "prod", entityNames: ["Role"], http: fake.http }),
    );
    expect(result.resources.Role.properties.ClientSecret).toBe("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain("s3cr3t");
  });

  test("a multi-stack project reads the stack it was handed", async () => {
    const fake = httpFake(() => stackResources([]));
    await observeResourcesDeepAws({ environment: "prod", entityNames: ["A"], stack: "payments-prod", http: fake.http });
    expect(fake.calls[0]?.body).toContain("StackName=payments-prod");
  });

  // #1269 — Cloud Control returns a security group's identity and description
  // and none of its rules, so the type is sourced from the EC2 API instead.
  describe("a type sourced from EC2 rather than Cloud Control", () => {
    const sgRow = (permissions: unknown[]) => ({
      GroupId: "sg-01",
      GroupName: "app-sg",
      Description: "app tier",
      VpcId: "vpc-1",
      Tags: [{ Key: "chant:managed-by", Value: "chant" }],
      IpPermissions: permissions,
      IpPermissionsEgress: [],
    });
    const ssh = {
      IpProtocol: "tcp",
      FromPort: 22,
      ToPort: 22,
      IpRanges: [{ CidrIp: "203.0.113.0/24", Description: "office" }],
    };

    test("reads the rules Cloud Control does not return, in the template's shape", async () => {
      spawnMock.mockResolvedValue({
        stdout: JSON.stringify({ SecurityGroups: [sgRow([ssh])] }),
        stderr: "",
        exitCode: 0,
      });
      const fake = httpFake(() => stackResources([["Perimeter", "AWS::EC2::SecurityGroup", "sg-01"]]));
      const result = normalizeDeepObservation(
        await observeResourcesDeepAws({ environment: "prod", entityNames: ["Perimeter"], http: fake.http }),
      );
      // EC2's `Description`/`IpPermissions` arrive as the CloudFormation model's
      // `GroupDescription`/`SecurityGroupIngress`, one flat rule per source.
      expect(result.resources.Perimeter.properties).toMatchObject({
        GroupDescription: "app tier",
        VpcId: "vpc-1",
        SecurityGroupIngress: [
          { IpProtocol: "tcp", FromPort: 22, ToPort: 22, CidrIp: "203.0.113.0/24", Description: "office" },
        ],
      });
      // The physical id is server-populated and pruned, as on every other type.
      expect(result.resources.Perimeter.properties.GroupId).toBeUndefined();
    });

    test("one describe for every group in the stack, not one per group", async () => {
      spawnMock.mockResolvedValue({
        stdout: JSON.stringify({ SecurityGroups: [sgRow([ssh]), { ...sgRow([]), GroupId: "sg-02" }] }),
        stderr: "",
        exitCode: 0,
      });
      const fake = httpFake(() =>
        stackResources([
          ["A", "AWS::EC2::SecurityGroup", "sg-01"],
          ["B", "AWS::EC2::SecurityGroup", "sg-02"],
        ]),
      );
      const result = normalizeDeepObservation(
        await observeResourcesDeepAws({ environment: "prod", entityNames: ["A", "B"], http: fake.http }),
      );
      expect(Object.keys(result.resources).sort()).toEqual(["A", "B"]);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls[0][0]).toEqual(expect.arrayContaining(["describe-security-groups", "sg-01", "sg-02"]));
    });

    test("a failed describe is a hole for that type, never an absence", async () => {
      spawnMock.mockResolvedValue({ stdout: "", stderr: "throttled", exitCode: 255 });
      const fake = httpFake(() => stackResources([["Perimeter", "AWS::EC2::SecurityGroup", "sg-01"]]));
      const result = normalizeDeepObservation(
        await observeResourcesDeepAws({ environment: "prod", entityNames: ["Perimeter"], http: fake.http }),
      );
      expect(result.resources).toEqual({});
      expect(result.unobserved.Perimeter.reason).toBe("read-failed");
    });

    test("a group the describe answered for but did not return is absent, not a hole", async () => {
      // The read succeeded and the id was not in it. The thin path reports that
      // absence; a second report here would turn one finding into two.
      spawnMock.mockResolvedValue({ stdout: JSON.stringify({ SecurityGroups: [] }), stderr: "", exitCode: 0 });
      const fake = httpFake(() => stackResources([["Perimeter", "AWS::EC2::SecurityGroup", "sg-01"]]));
      const result = normalizeDeepObservation(
        await observeResourcesDeepAws({ environment: "prod", entityNames: ["Perimeter"], http: fake.http }),
      );
      expect(result.resources).toEqual({});
      expect(result.unobserved).toEqual({});
    });

    test("--owned reads the marker off the EC2 tags", async () => {
      spawnMock.mockResolvedValue({
        stdout: JSON.stringify({ SecurityGroups: [{ ...sgRow([ssh]), Tags: [{ Key: "team", Value: "other" }] }] }),
        stderr: "",
        exitCode: 0,
      });
      const fake = httpFake(() => stackResources([["Perimeter", "AWS::EC2::SecurityGroup", "sg-01"]]));
      const result = normalizeDeepObservation(
        await observeResourcesDeepAws({ environment: "prod", entityNames: ["Perimeter"], owned: true, http: fake.http }),
      );
      expect(result.unobserved.Perimeter.reason).toBe("filtered");
    });
  });

  test("the per-resource reads are concurrent, not one round trip after another", async () => {
    let inFlight = 0;
    let peak = 0;
    const http = async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      const target = init.headers["x-amz-target"];
      if (!target) {
        return stackResources([
          ["A", "AWS::S3::Bucket", "a"],
          ["B", "AWS::S3::Bucket", "b"],
          ["C", "AWS::S3::Bucket", "c"],
        ]);
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const identifier = (JSON.parse(init.body) as { Identifier: string }).Identifier;
      return cloudControl(identifier, { BucketName: identifier });
    };
    const result = normalizeDeepObservation(
      await observeResourcesDeepAws({ environment: "prod", entityNames: ["A", "B", "C"], http }),
    );
    expect(Object.keys(result.resources).sort()).toEqual(["A", "B", "C"]);
    expect(peak).toBeGreaterThan(1);
  });
});

/**
 * The acceptance test for #1015: the real plugin, a mutated live tree, a
 * baseline, and exactly the genuine drift.
 */
describe("end to end: declared + mutated live + baseline (#1015)", () => {
  // The security group in this estate is sourced from EC2 (#1269), which still
  // shells the CLI; it stands in for a deep read that fails.
  beforeEach(() => spawnMock.mockResolvedValue({ stdout: "", stderr: "throttled", exitCode: 255 }));
  // This block drives the real plugin, which builds its own transport, so the
  // seam here is `fetch` itself rather than an injected `http` (#1206).
  afterEach(() => {
    vi.restoreAllMocks();
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
    vi.spyOn(globalThis, "fetch").mockImplementation((async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      const target = init.headers["x-amz-target"];
      const identifier = target ? (JSON.parse(init.body) as { Identifier: string }).Identifier : undefined;
      const respond = (r: { status: number; text: string }) =>
        ({ status: r.status, text: () => Promise.resolve(r.text) });

      if (identifier === undefined) {
        return respond(
          stackResources([
            ["Assets", "AWS::S3::Bucket", "acme-assets"],
            ["AppRole", "AWS::IAM::Role", "app-role"],
            ["Jobs", "AWS::SQS::Queue", "jobs"],
            ["Perimeter", "AWS::EC2::SecurityGroup", "sg-01"],
          ]),
        );
      }
      if (identifier === "acme-assets") {
        return respond(
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
      if (identifier === "app-role") {
        return respond(
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
      if (identifier === "sg-01") {
        return respond(apiError("ValidationException", "sg-01 is read through EC2, not Cloud Control"));
      }
      return respond(apiError("ValidationException", `unexpected call for ${identifier}`));
    }) as unknown as typeof fetch);
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
        detail: "no deep reader for AWS::SQS::Queue — coverage is opt-in per type",
      },
      {
        name: "Perimeter",
        type: "AWS::EC2::SecurityGroup",
        reason: "read-failed",
        detail:
          "ec2 describe-security-groups failed, so AWS::EC2::SecurityGroup could not be read deeply",
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
    // The stack read itself is refused, so nothing downstream ever runs. CFN
    // speaks the Query protocol, so the refusal arrives as an `<Error>`
    // document rather than the JSON one Cloud Control would send.
    const refused = queryError("AccessDenied", "User is not authorized to perform cloudformation:DescribeStackResources");
    vi.spyOn(globalThis, "fetch").mockImplementation((async () => ({
      status: refused.status,
      text: () => Promise.resolve(refused.text),
    })) as unknown as typeof fetch);
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
