/**
 * The native AWS read transport (#1206).
 *
 * The transport is injected everywhere, so nothing here reaches a network. The
 * XML cases are the ones worth being careful about: the applier's `xmlField`
 * only ever handled flat scalars, and the read path needs `<member>` lists.
 */
import { describe, test, expect } from "vitest";
import {
  AwsReadError,
  describeStackOutputs,
  describeStackResources,
  getResource,
  listResources,
  parseResourceDescription,
  resolveEndpointOverride,
  serviceEndpointEnvVar,
  serviceUrl,
  xmlLeaves,
  xmlMembers,
  xmlError,
  type AwsReadHttp,
} from "./read-client";
import { EMPTY_PAYLOAD_SHA256 } from "./sigv4";

const respond = (text: string, status = 200): ReturnType<AwsReadHttp> => Promise.resolve({ status, text });

/** Records every call so a test can assert what went on the wire. */
function recording(handler: (body: string, headers: Record<string, string>) => ReturnType<AwsReadHttp>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const http: AwsReadHttp = (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return handler(init.body, init.headers);
  };
  return { http, calls };
}

const stackXml = `
<DescribeStackResourcesResponse><DescribeStackResourcesResult><StackResources>
  <member>
    <LogicalResourceId>dataBucket</LogicalResourceId>
    <ResourceType>AWS::S3::Bucket</ResourceType>
    <PhysicalResourceId>acme-assets</PhysicalResourceId>
    <ResourceStatus>CREATE_COMPLETE</ResourceStatus>
    <Timestamp>2026-01-01T00:00:00Z</Timestamp>
  </member>
  <member>
    <LogicalResourceId>vpc</LogicalResourceId>
    <ResourceType>AWS::EC2::VPC</ResourceType>
    <PhysicalResourceId>vpc-01</PhysicalResourceId>
    <ResourceStatus>CREATE_COMPLETE</ResourceStatus>
  </member>
</StackResources></DescribeStackResourcesResult></DescribeStackResourcesResponse>`;

describe("serviceUrl", () => {
  test("an override wins over the regional host, with exactly one trailing slash", () => {
    expect(serviceUrl("cloudformation", "http://localhost:4566")).toBe("http://localhost:4566/");
    expect(serviceUrl("cloudformation", "http://localhost:4566/")).toBe("http://localhost:4566/");
  });

  test("without an override it is the real regional host for that service", () => {
    expect(serviceUrl("cloudcontrolapi", undefined, "eu-west-1")).toBe("https://cloudcontrolapi.eu-west-1.amazonaws.com/");
  });
});

describe("the Query XML shapes", () => {
  test("xmlLeaves flattens one fragment and decodes entities", () => {
    expect(xmlLeaves("<A>1</A><B>x &amp; y</B>")).toEqual({ A: "1", B: "x & y" });
  });

  test("xmlLeaves keeps the first of a repeated tag", () => {
    expect(xmlLeaves("<A>first</A><A>second</A>")).toEqual({ A: "first" });
  });

  test("xmlMembers reads a member list, which xmlField never could", () => {
    expect(xmlMembers(stackXml, "StackResources")).toHaveLength(2);
  });

  test("xmlMembers is empty for an absent list rather than throwing", () => {
    expect(xmlMembers("<Response/>", "StackResources")).toEqual([]);
  });

  test("xmlError finds a Query error document, and nothing in a success body", () => {
    expect(xmlError("<ErrorResponse><Error><Code>ValidationError</Code><Message>nope</Message></Error></ErrorResponse>")).toEqual({
      code: "ValidationError",
      message: "nope",
    });
    expect(xmlError(stackXml)).toBeUndefined();
  });
});

describe("describeStackResources", () => {
  test("maps members onto the read path's shape, keeping optional fields optional", async () => {
    const { http, calls } = recording(() => respond(stackXml));
    const resources = await describeStackResources("local", { endpoint: "http://localhost:4566", http });

    expect(resources).toEqual([
      {
        logicalId: "dataBucket",
        type: "AWS::S3::Bucket",
        physicalId: "acme-assets",
        status: "CREATE_COMPLETE",
        timestamp: "2026-01-01T00:00:00Z",
      },
      { logicalId: "vpc", type: "AWS::EC2::VPC", physicalId: "vpc-01", status: "CREATE_COMPLETE" },
    ]);
    expect(calls[0].url).toBe("http://localhost:4566/");
    expect(calls[0].body).toContain("Action=DescribeStackResources");
    expect(calls[0].body).toContain("StackName=local");
  });

  test("a Query error becomes a typed throw carrying the service's own code", async () => {
    const { http } = recording(() =>
      respond("<ErrorResponse><Error><Code>ValidationError</Code><Message>Stack with id local does not exist</Message></Error></ErrorResponse>", 400),
    );
    await expect(describeStackResources("local", { http })).rejects.toMatchObject({
      name: "AwsReadError",
      code: "ValidationError",
      status: 400,
    });
  });

  test("a non-2xx with no error document still throws rather than parsing as empty", async () => {
    const { http } = recording(() => respond("<html>502</html>", 502));
    await expect(describeStackResources("local", { http })).rejects.toBeInstanceOf(AwsReadError);
  });
});

describe("describeStackOutputs", () => {
  test("reads the output members as a flat record", async () => {
    const { http } = recording(() =>
      respond(`<DescribeStacksResponse><Outputs>
        <member><OutputKey>VpcId</OutputKey><OutputValue>vpc-01</OutputValue></member>
        <member><OutputKey>Empty</OutputKey></member>
      </Outputs></DescribeStacksResponse>`),
    );
    expect(await describeStackOutputs("local", { http })).toEqual({ VpcId: "vpc-01", Empty: "" });
  });
});

describe("Cloud Control", () => {
  const description = (identifier: string, properties: Record<string, unknown>) => ({
    Identifier: identifier,
    Properties: JSON.stringify(properties),
  });

  test("getResource unwraps the doubly-encoded model and targets the JSON 1.0 operation", async () => {
    const { http, calls } = recording(() =>
      respond(JSON.stringify({ ResourceDescription: description("acme-assets", { BucketName: "acme-assets" }) })),
    );
    expect(await getResource("AWS::S3::Bucket", "acme-assets", { http })).toEqual({
      identifier: "acme-assets",
      properties: { BucketName: "acme-assets" },
    });
    expect(calls[0].headers["x-amz-target"]).toBe("CloudApiService.GetResource");
    expect(calls[0].headers["content-type"]).toBe("application/x-amz-json-1.0");
  });

  test("a modelled error becomes a typed throw — UnsupportedOperation is not a miss", async () => {
    const { http } = recording(() =>
      respond(JSON.stringify({ __type: "UnsupportedOperation", message: "Operation GetResource is not supported." }), 400),
    );
    await expect(getResource("AWS::S3::Bucket", "b", { http })).rejects.toMatchObject({
      code: "UnsupportedOperation",
      status: 400,
    });
  });

  test("a `__type` carrying a shape prefix is reported by its bare name", async () => {
    const { http } = recording(() =>
      respond(JSON.stringify({ __type: "com.amazonaws.cloudapi#ThrottlingException", message: "Rate exceeded" }), 400),
    );
    await expect(getResource("AWS::S3::Bucket", "b", { http })).rejects.toMatchObject({ code: "ThrottlingException" });
  });

  test("listResources follows NextToken to exhaustion", async () => {
    let page = 0;
    const { http, calls } = recording(() => {
      page += 1;
      return respond(
        JSON.stringify(
          page === 1
            ? { ResourceDescriptions: [description("a", { BucketName: "a" })], NextToken: "more" }
            : { ResourceDescriptions: [description("b", { BucketName: "b" })] },
        ),
      );
    });
    const all = await listResources("AWS::S3::Bucket", { http });
    expect(all.map((r) => r.identifier)).toEqual(["a", "b"]);
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toContain("more");
  });

  test("an unparseable description is dropped, not returned as an empty resource", async () => {
    const { http } = recording(() =>
      respond(JSON.stringify({ ResourceDescriptions: [{ Identifier: "a", Properties: "{oops" }] })),
    );
    expect(await listResources("AWS::S3::Bucket", { http })).toEqual([]);
  });

  test("listResources scopes a child listing with ResourceModel, JSON-encoded as the API takes it", async () => {
    const { http, calls } = recording(() => respond(JSON.stringify({ ResourceDescriptions: [] })));
    await listResources("AWS::IAM::RolePolicy", { http }, { RoleName: "app-role" });
    expect(JSON.parse(calls[0].body)).toEqual({
      TypeName: "AWS::IAM::RolePolicy",
      ResourceModel: JSON.stringify({ RoleName: "app-role" }),
    });
  });

  test("parseResourceDescription refuses anything that is not a model object", () => {
    expect(parseResourceDescription(null)).toBeNull();
    expect(parseResourceDescription({ Identifier: "a" })).toBeNull();
    expect(parseResourceDescription({ Properties: JSON.stringify(["not", "an", "object"]) })).toBeNull();
  });
});

describe("the region an endpoint override cannot carry in its host", () => {
  // An override is one host for every region, so the hostname says nothing and
  // the region has to travel in the request. It did not, and a stack declared
  // `region: "us-west-1"` was read against the emulator's default region —
  // where it genuinely does not exist, so the read came back empty and the
  // snapshot recorded that region as holding nothing.
  test("the request names the region in its credential scope", async () => {
    const { http, calls } = recording(() => respond(stackXml));
    await describeStackResources("web", { endpoint: "http://localhost:4566", region: "us-west-1", http, env: {} });
    expect(calls[0].headers.authorization).toContain("/us-west-1/cloudformation/aws4_request");
  });

  test("Cloud Control carries it too, scoped to its own service", async () => {
    const { http, calls } = recording(() => respond(JSON.stringify({ ResourceDescription: {} })));
    await getResource("AWS::EC2::VPC", "vpc-01", { endpoint: "http://localhost:4566", region: "eu-west-1", http, env: {} });
    expect(calls[0].headers.authorization).toContain("/eu-west-1/cloudcontrolapi/aws4_request");
  });

  test("no region, no header — nothing invents one", async () => {
    const { http, calls } = recording(() => respond(stackXml));
    await describeStackResources("web", { endpoint: "http://localhost:4566", http, env: {} });
    expect(calls[0].headers.authorization).toBeUndefined();
  });

  test("it is a scope, not a signature — the placeholder says so", async () => {
    const { http, calls } = recording(() => respond(stackXml));
    await describeStackResources("web", { region: "us-west-1", http, env: {} });
    expect(calls[0].headers.authorization).toContain("Signature=unsigned");
  });
});

/**
 * The signing decision, as the client makes it. `./sigv4.test.ts` proves the
 * signature is correct against AWS's own vectors; these prove the client only
 * produces one when it should.
 */
describe("SigV4 on the read path", () => {
  const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
  const now = new Date("2015-08-30T12:36:00Z");

  test("credentials and a real host produce a signed request, not the placeholder", async () => {
    const { http, calls } = recording(() => respond(stackXml));
    await describeStackResources("web", { region: "us-west-1", credentials, now, http, env: {} });

    const auth = calls[0].headers.authorization;
    expect(auth).toContain("Credential=AKIDEXAMPLE/20150830/us-west-1/cloudformation/aws4_request");
    expect(auth).not.toContain("Signature=unsigned");
    expect(auth).toMatch(/Signature=[0-9a-f]{64}$/);
    expect(calls[0].headers["x-amz-date"]).toBe("20150830T123600Z");
    // The body hash, not the empty-payload constant — the Query call has a body.
    expect(calls[0].headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0].headers["x-amz-content-sha256"]).not.toBe(EMPTY_PAYLOAD_SHA256);
    // `host` is signed but never emitted: fetch computes it and forbids the override.
    expect(calls[0].headers.host).toBeUndefined();
    expect(auth).toContain("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date");
  });

  test("an endpoint override is not signed, so the emulator lanes need no credentials", async () => {
    const { http, calls } = recording(() => respond(stackXml));
    await describeStackResources("web", {
      endpoint: "http://localhost:4566",
      region: "us-west-1",
      credentials,
      http,
      env: {},
    });
    expect(calls[0].headers.authorization).toContain("Signature=unsigned");
    expect(calls[0].headers["x-amz-date"]).toBeUndefined();
  });

  test("signEndpointOverride signs one anyway — for an override that is real AWS", async () => {
    const { http, calls } = recording(() => respond(stackXml));
    await describeStackResources("web", {
      endpoint: "https://vpce-1234.cloudformation.us-west-1.vpce.amazonaws.com",
      region: "us-west-1",
      credentials,
      signEndpointOverride: true,
      now,
      http,
      env: {},
    });
    expect(calls[0].headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  test("no credentials leaves the old unsigned path exactly as it was", async () => {
    const { http, calls } = recording(() => respond(stackXml));
    await describeStackResources("web", { region: "us-west-1", http, env: {} });
    expect(calls[0].headers.authorization).toContain("Signature=unsigned");
    expect(calls[0].headers["x-amz-date"]).toBeUndefined();
    expect(calls[0].headers["x-amz-content-sha256"]).toBeUndefined();
  });

  test("the environment is the fallback source, and Cloud Control signs from it too", async () => {
    const { http, calls } = recording(() => respond(JSON.stringify({ ResourceDescription: {} })));
    await getResource("AWS::EC2::VPC", "vpc-01", {
      region: "eu-west-1",
      now,
      http,
      env: { AWS_ACCESS_KEY_ID: "AKIDENV", AWS_SECRET_ACCESS_KEY: "s", AWS_SESSION_TOKEN: "tok" },
    });
    expect(calls[0].headers.authorization).toContain("Credential=AKIDENV/20150830/eu-west-1/cloudcontrolapi/");
    expect(calls[0].headers["x-amz-security-token"]).toBe("tok");
    expect(calls[0].headers["x-amz-target"]).toBe("CloudApiService.GetResource");
  });

  test("signing without a named region falls back to the same default the host does", async () => {
    const { http, calls } = recording(() => respond(stackXml));
    await describeStackResources("web", { credentials, now, http, env: {} });
    expect(calls[0].url).toBe("https://cloudformation.us-east-1.amazonaws.com/");
    expect(calls[0].headers.authorization).toContain("/20150830/us-east-1/cloudformation/aws4_request");
  });
});

describe("what counts as an endpoint override (#1694)", () => {
  const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
  const now = new Date("2015-08-30T12:36:00Z");

  test("the option, then the service variable, then AWS_ENDPOINT_URL — the SDK's precedence", () => {
    const env = { AWS_ENDPOINT_URL: "http://all:1", AWS_ENDPOINT_URL_CLOUDFORMATION: "http://cfn:2" };
    expect(resolveEndpointOverride("cloudformation", "http://opt:3", env)).toBe("http://opt:3");
    expect(resolveEndpointOverride("cloudformation", undefined, env)).toBe("http://cfn:2");
    expect(resolveEndpointOverride("cloudcontrolapi", undefined, env)).toBe("http://all:1");
    expect(resolveEndpointOverride("cloudformation", undefined, {})).toBeUndefined();
    expect(resolveEndpointOverride("cloudformation", "", { AWS_ENDPOINT_URL: "" })).toBeUndefined();
  });

  test("the service variable is named by the SDK's service id, not the signing name", () => {
    expect(serviceEndpointEnvVar("cloudformation")).toBe("AWS_ENDPOINT_URL_CLOUDFORMATION");
    expect(serviceEndpointEnvVar("cloudcontrolapi")).toBe("AWS_ENDPOINT_URL_CLOUDCONTROL");
    expect(serviceEndpointEnvVar("bedrock-agentcore")).toBe("AWS_ENDPOINT_URL_BEDROCK_AGENTCORE");
  });

  test("AWS_ENDPOINT_URL alone retargets the request and leaves it unsigned, like the option", async () => {
    const { http, calls } = recording(() => respond(stackXml));
    await describeStackResources("web", {
      region: "us-west-1",
      credentials,
      http,
      env: { AWS_ENDPOINT_URL: "http://localhost:4566" },
    });
    expect(calls[0].url).toBe("http://localhost:4566/");
    expect(calls[0].headers.authorization).toContain("Signature=unsigned");
    expect(calls[0].headers["x-amz-date"]).toBeUndefined();
  });

  test("the service-specific variable does the same, for Cloud Control too", async () => {
    const { http, calls } = recording(() => respond(JSON.stringify({ ResourceDescription: {} })));
    await getResource("AWS::EC2::VPC", "vpc-01", {
      region: "eu-west-1",
      credentials,
      http,
      env: { AWS_ENDPOINT_URL_CLOUDCONTROL: "http://localhost:4566" },
    });
    expect(calls[0].url).toBe("http://localhost:4566/");
    expect(calls[0].headers.authorization).toContain("Signature=unsigned");
  });

  test("the option is the same override — same target, same unsigned headers", async () => {
    const viaEnv = recording(() => respond(stackXml));
    const viaOption = recording(() => respond(stackXml));
    await describeStackResources("web", {
      region: "us-west-1",
      credentials,
      http: viaEnv.http,
      env: { AWS_ENDPOINT_URL: "http://localhost:4566" },
    });
    await describeStackResources("web", {
      endpoint: "http://localhost:4566",
      region: "us-west-1",
      credentials,
      http: viaOption.http,
      env: {},
    });
    expect(viaOption.calls[0]).toEqual(viaEnv.calls[0]);
  });

  test("signEndpointOverride signs against an override the environment named", async () => {
    const { http, calls } = recording(() => respond(stackXml));
    await describeStackResources("web", {
      region: "us-west-1",
      credentials,
      signEndpointOverride: true,
      now,
      http,
      env: { AWS_ENDPOINT_URL: "https://vpce-1234.cloudformation.us-west-1.vpce.amazonaws.com" },
    });
    expect(calls[0].url).toBe("https://vpce-1234.cloudformation.us-west-1.vpce.amazonaws.com/");
    expect(calls[0].headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  test("neither option nor variable: the real regional host, signed", async () => {
    const { http, calls } = recording(() => respond(stackXml));
    await describeStackResources("web", { region: "us-west-1", credentials, now, http, env: {} });
    expect(calls[0].url).toBe("https://cloudformation.us-west-1.amazonaws.com/");
    expect(calls[0].headers.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });
});
