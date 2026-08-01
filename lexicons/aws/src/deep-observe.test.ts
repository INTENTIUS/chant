/**
 * AWS deep observation (#1015) — the reference row of the deep-observe contract
 * (#1014).
 *
 * Every AWS interaction here is a faked HTTP call (#1206). Nothing spawns a
 * CLI, reads ambient credentials, or reaches a network: the reader's only edge
 * is its transport, which is injected as `http` where the reader is called
 * directly and stubbed at `fetch` where the plugin builds its own.
 */
import { describe, test, expect, vi, afterEach } from "vitest";

const { awsPlugin } = await import("./plugin");
const {
  observeResourcesDeepAws,
  awsDeepNormalizationHooks,
  hasOwnershipMarker,
} = await import("./deep-observe");
const { parseResourceDescription } = await import("./api/read-client");
const { deepDiffForLexicon } = await import("@intentius/chant/lifecycle/deep-observe");
const { normalizeDeepObservation, normalizeDeepProperties } = await import("@intentius/chant/deep-observation");

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
        return respond(apiError("ThrottlingException", "Rate exceeded"));
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
        detail: "no deep reader for AWS::SQS::Queue — Cloud Control coverage is opt-in per type",
      },
      {
        name: "Perimeter",
        type: "AWS::EC2::SecurityGroup",
        reason: "read-failed",
        detail:
          'GetResource failed for AWS::EC2::SecurityGroup "sg-01": ThrottlingException: Rate exceeded',
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
