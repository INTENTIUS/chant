/**
 * `chant lifecycle whoami` for AWS (chant #1982).
 *
 * The transport is injected everywhere here, so nothing reaches a network and
 * no real credential is involved. The load-bearing test is the last one: the
 * identity query and the declared-entity read must resolve the same target,
 * because a whoami that names a binding the read does not use is worse than no
 * whoami at all.
 */
import { describe, test, expect } from "vitest";
import { describeIdentity } from "./caller-identity";
import { describeStackResources, type AwsReadHttp } from "./api/read-client";

const CALLER_IDENTITY_XML = `
<GetCallerIdentityResponse><GetCallerIdentityResult>
  <Arn>arn:aws:sts::491500000000:assumed-role/deploy/ci</Arn>
  <UserId>AROAEXAMPLEID123456:ci</UserId>
  <Account>491500000000</Account>
</GetCallerIdentityResult></GetCallerIdentityResponse>`;

const STACK_XML = `
<DescribeStackResourcesResponse><DescribeStackResourcesResult><StackResources>
  <member>
    <LogicalResourceId>bucket</LogicalResourceId>
    <ResourceType>AWS::S3::Bucket</ResourceType>
  </member>
</StackResources></DescribeStackResourcesResult></DescribeStackResourcesResponse>`;

/** Records every request so a test can assert what went on the wire. */
function recording(text: string, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const http: AwsReadHttp = (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return Promise.resolve({ status, text });
  };
  return { http, calls };
}

/** Credentials that exist only in this record — never read from the process. */
const CREDS = { AWS_ACCESS_KEY_ID: "AKIAEXAMPLEKEYID0000", AWS_SECRET_ACCESS_KEY: "notarealsecret" };

describe("aws describeIdentity (#1982)", () => {
  test("reports the STS principal, the account+region scope, and where the binding came from", async () => {
    const { http, calls } = recording(CALLER_IDENTITY_XML);
    const result = await describeIdentity({
      environment: "prod",
      region: "eu-west-1",
      client: { http, env: CREDS },
    });

    expect(result).toEqual({
      identity: "arn:aws:sts::491500000000:assumed-role/deploy/ci",
      scope: "491500000000 eu-west-1",
      source: "env AWS_ACCESS_KEY_ID; stacks[].region",
      endpoint: "https://sts.eu-west-1.amazonaws.com/",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toContain("Action=GetCallerIdentity");
    // The principal id adds nothing an ARN does not already say, and the
    // narrower the surface the fewer ways a credential reaches a report.
    expect(JSON.stringify(result)).not.toContain("AROAEXAMPLEID123456");
  });

  test("no environment credentials against real AWS is no-credentials, and the call is never made", async () => {
    const { http, calls } = recording(CALLER_IDENTITY_XML);
    const result = await describeIdentity({ environment: "prod", client: { http, env: {} } });
    expect(result).toEqual({
      unresolved: {
        reason: "no-credentials",
        detail: "no AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment",
      },
    });
    expect(calls).toHaveLength(0);
  });

  test("AWS_PROFILE alone is reported as no-credentials, naming the profile that does not sign", async () => {
    const { http } = recording(CALLER_IDENTITY_XML);
    const result = await describeIdentity({
      environment: "prod",
      client: { http, env: { AWS_PROFILE: "acme-ci" } },
    });
    expect(result).toMatchObject({ unresolved: { reason: "no-credentials" } });
    const detail = (result as { unresolved: { detail: string } }).unresolved.detail;
    expect(detail).toContain("AWS_PROFILE=acme-ci");
    expect(detail).toContain("not the profile file");
  });

  test("an unsigned emulator read still resolves an identity, and says it was unsigned", async () => {
    const { http, calls } = recording(CALLER_IDENTITY_XML);
    const result = await describeIdentity({
      environment: "floci",
      client: { http, env: { AWS_ENDPOINT_URL: "http://localhost:4566" } },
    });
    expect(result).toMatchObject({
      identity: "arn:aws:sts::491500000000:assumed-role/deploy/ci",
      endpoint: "http://localhost:4566/",
    });
    expect((result as { source: string }).source).toContain("unsigned (endpoint override)");
    expect((result as { source: string }).source).toContain("endpoint override http://localhost:4566");
    expect(calls[0].url).toBe("http://localhost:4566/");
  });

  test("a refused call is no-credentials; a broken one is read-failed", async () => {
    const denied = recording(
      "<ErrorResponse><Error><Code>InvalidClientTokenId</Code><Message>bad token</Message></Error></ErrorResponse>",
      403,
    );
    expect(
      await describeIdentity({ environment: "prod", client: { http: denied.http, env: CREDS } }),
    ).toMatchObject({ unresolved: { reason: "no-credentials" } });

    const broken = recording(
      "<ErrorResponse><Error><Code>ServiceUnavailable</Code><Message>try later</Message></Error></ErrorResponse>",
      503,
    );
    const result = await describeIdentity({ environment: "prod", client: { http: broken.http, env: CREDS } });
    expect(result).toMatchObject({ unresolved: { reason: "read-failed" } });
    expect((result as { unresolved: { detail: string } }).unresolved.detail).toContain("ServiceUnavailable");
  });

  test("an answer with no Arn is read-failed, never an empty identity", async () => {
    const { http } = recording("<GetCallerIdentityResponse><GetCallerIdentityResult/></GetCallerIdentityResponse>");
    const result = await describeIdentity({ environment: "prod", client: { http, env: CREDS } });
    expect(result).toMatchObject({ unresolved: { reason: "read-failed" } });
  });

  test("the region an undeclared project actually reads is reported, not the one AWS_REGION suggests", async () => {
    // The read transport takes its region from `stacks[].region` and defaults
    // to us-east-1; it does not consult AWS_REGION. Reporting the shell's var
    // here would describe a target no read uses.
    const { http, calls } = recording(CALLER_IDENTITY_XML);
    const result = await describeIdentity({
      environment: "prod",
      client: { http, env: { ...CREDS, AWS_REGION: "ap-south-1" } },
    });
    expect((result as { scope: string }).scope).toBe("491500000000 us-east-1");
    expect((result as { source: string }).source).toContain("AWS_REGION=ap-south-1 is not read by this transport");
    expect(calls[0].url).toBe("https://sts.us-east-1.amazonaws.com/");
  });

  test("no credential material appears anywhere in the reported row", async () => {
    const { http } = recording(CALLER_IDENTITY_XML);
    const result = await describeIdentity({ environment: "prod", client: { http, env: CREDS } });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CREDS.AWS_SECRET_ACCESS_KEY);
    expect(serialized).not.toContain(CREDS.AWS_ACCESS_KEY_ID);
  });
});

describe("whoami and the live read resolve the same target (#1982 acceptance)", () => {
  test("an endpoint override sends both to the same origin", async () => {
    const env = { ...CREDS, AWS_ENDPOINT_URL: "http://localhost:4566" };

    const identityHttp = recording(CALLER_IDENTITY_XML);
    const identity = await describeIdentity({
      environment: "floci",
      region: "eu-west-1",
      client: { http: identityHttp.http, env },
    });

    const readHttp = recording(STACK_XML);
    await describeStackResources("floci", { http: readHttp.http, env, region: "eu-west-1" });

    const origin = (url: string): string => new URL(url).origin;
    expect(origin(identityHttp.calls[0].url)).toBe(origin(readHttp.calls[0].url));
    // And the row names it, so the operator sees the target rather than
    // inferring it.
    expect((identity as { endpoint: string }).endpoint).toBe(readHttp.calls[0].url);
  });

  test("against real AWS both resolve the same region, on each service's own host", async () => {
    const identityHttp = recording(CALLER_IDENTITY_XML);
    await describeIdentity({
      environment: "prod",
      region: "eu-west-1",
      client: { http: identityHttp.http, env: CREDS },
    });

    const readHttp = recording(STACK_XML);
    await describeStackResources("prod", { http: readHttp.http, env: CREDS, region: "eu-west-1" });

    const host = (url: string): string => new URL(url).host;
    expect(host(identityHttp.calls[0].url)).toBe("sts.eu-west-1.amazonaws.com");
    expect(host(readHttp.calls[0].url)).toBe("cloudformation.eu-west-1.amazonaws.com");
    // The credential scope both signatures carry is the same region — which is
    // the part a wrong answer would get wrong.
    for (const calls of [identityHttp.calls, readHttp.calls]) {
      expect(calls[0].headers.authorization ?? calls[0].headers.Authorization).toContain("/eu-west-1/");
    }
  });
});
