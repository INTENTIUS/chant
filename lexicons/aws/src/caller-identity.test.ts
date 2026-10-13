/**
 * `chant lifecycle whoami` for AWS (chant #1982).
 *
 * The transport is injected everywhere here, so nothing reaches a network and
 * no real credential is involved. The load-bearing test is the last one: the
 * identity query and the declared-entity read must resolve the same target,
 * because a whoami that names a binding the read does not use is worse than no
 * whoami at all.
 */
import { createHash } from "node:crypto";
import { describe, test, expect } from "vitest";
import { describeIdentity, type CallerIdentityOptions } from "./caller-identity";
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

/**
 * No shared config or credentials files: the chain must never read the real
 * `~/.aws` of whoever runs the suite. Tests that exercise profiles inject
 * their own files.
 */
const NO_FILES = { home: "/nonexistent-home", readFile: () => undefined };

function whoami(options: CallerIdentityOptions) {
  return describeIdentity({ ...options, chain: { ...NO_FILES, ...options.chain } });
}

/** Credentials that exist only in this record — never read from the process. */
const CREDS = { AWS_ACCESS_KEY_ID: "AKIAEXAMPLEKEYID0000", AWS_SECRET_ACCESS_KEY: "notarealsecret" };

describe("aws describeIdentity (#1982)", () => {
  test("reports the STS principal, the account+region scope, and where the binding came from", async () => {
    const { http, calls } = recording(CALLER_IDENTITY_XML);
    const result = await whoami({
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
    const result = await whoami({ environment: "prod", client: { http, env: {} } });
    expect(result).toEqual({
      unresolved: {
        reason: "no-credentials",
        detail:
          "no AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment, no AWS_PROFILE, and no default profile in /nonexistent-home/.aws/config or /nonexistent-home/.aws/credentials",
      },
    });
    expect(calls).toHaveLength(0);
  });

  test("an AWS_PROFILE that names no profile is no-credentials, naming the profile and the files read", async () => {
    const { http, calls } = recording(CALLER_IDENTITY_XML);
    const result = await whoami({
      environment: "prod",
      client: { http, env: { AWS_PROFILE: "acme-ci" } },
    });
    expect(result).toMatchObject({ unresolved: { reason: "no-credentials" } });
    const detail = (result as { unresolved: { detail: string } }).unresolved.detail;
    expect(detail).toContain("AWS_PROFILE=acme-ci");
    expect(detail).toContain("/nonexistent-home/.aws/config");
    expect(calls).toHaveLength(0);
  });

  test("an unsigned emulator read still resolves an identity, and says it was unsigned", async () => {
    const { http, calls } = recording(CALLER_IDENTITY_XML);
    const result = await whoami({
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
      await whoami({ environment: "prod", client: { http: denied.http, env: CREDS } }),
    ).toMatchObject({ unresolved: { reason: "no-credentials" } });

    const broken = recording(
      "<ErrorResponse><Error><Code>ServiceUnavailable</Code><Message>try later</Message></Error></ErrorResponse>",
      503,
    );
    const result = await whoami({ environment: "prod", client: { http: broken.http, env: CREDS } });
    expect(result).toMatchObject({ unresolved: { reason: "read-failed" } });
    expect((result as { unresolved: { detail: string } }).unresolved.detail).toContain("ServiceUnavailable");
  });

  test("an answer with no Arn is read-failed, never an empty identity", async () => {
    const { http } = recording("<GetCallerIdentityResponse><GetCallerIdentityResult/></GetCallerIdentityResponse>");
    const result = await whoami({ environment: "prod", client: { http, env: CREDS } });
    expect(result).toMatchObject({ unresolved: { reason: "read-failed" } });
  });

  test("the region an undeclared project actually reads is reported, not the one AWS_REGION suggests", async () => {
    // The read transport takes its region from `stacks[].region` and defaults
    // to us-east-1; it does not consult AWS_REGION. Reporting the shell's var
    // here would describe a target no read uses.
    const { http, calls } = recording(CALLER_IDENTITY_XML);
    const result = await whoami({
      environment: "prod",
      client: { http, env: { ...CREDS, AWS_REGION: "ap-south-1" } },
    });
    expect((result as { scope: string }).scope).toBe("491500000000 us-east-1");
    expect((result as { source: string }).source).toContain("AWS_REGION=ap-south-1 is not read by this transport");
    expect(calls[0].url).toBe("https://sts.us-east-1.amazonaws.com/");
  });

  test("no credential material appears anywhere in the reported row", async () => {
    const { http } = recording(CALLER_IDENTITY_XML);
    const result = await whoami({ environment: "prod", client: { http, env: CREDS } });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(CREDS.AWS_SECRET_ACCESS_KEY);
    expect(serialized).not.toContain(CREDS.AWS_ACCESS_KEY_ID);
  });
});

describe("whoami and the live read resolve the same target (#1982 acceptance)", () => {
  test("an endpoint override sends both to the same origin", async () => {
    const env = { ...CREDS, AWS_ENDPOINT_URL: "http://localhost:4566" };

    const identityHttp = recording(CALLER_IDENTITY_XML);
    const identity = await whoami({
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
    await whoami({
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

describe("whoami resolves AWS profiles the way the AWS CLI does (#3954)", () => {
  const HOME = "/home/op";
  const files = (map: Record<string, string>) => ({ home: HOME, readFile: (path: string) => map[path] });

  test("a static-key profile named by AWS_PROFILE signs the call and is named as the source", async () => {
    const { http, calls } = recording(CALLER_IDENTITY_XML);
    const result = await whoami({
      environment: "prod",
      client: { http, env: { AWS_PROFILE: "dev" } },
      chain: files({
        [`${HOME}/.aws/credentials`]: "[dev]\naws_access_key_id = AKIAPROFILEKEY00000\naws_secret_access_key = profilesecret\n",
      }),
    });
    expect(result).toMatchObject({
      identity: "arn:aws:sts::491500000000:assumed-role/deploy/ci",
      source: "profile dev (static keys); chant default (no stacks[].region)",
    });
    expect(calls[0].headers.authorization).toContain("Credential=AKIAPROFILEKEY00000/");
    expect(JSON.stringify(result)).not.toContain("profilesecret");
  });

  test("an SSO-session profile is resolved through the cached token and the SSO portal", async () => {
    const sts = recording(CALLER_IDENTITY_XML);
    const portal: Array<{ url: string; headers: Record<string, string> }> = [];
    const result = await whoami({
      environment: "prod",
      client: { http: sts.http, env: { AWS_PROFILE: "loom" } },
      chain: {
        ...files({
          [`${HOME}/.aws/config`]: [
            "[profile loom]",
            "sso_session = acme",
            "sso_account_id = 491500000000",
            "sso_role_name = Deployer",
            "",
            "[sso-session acme]",
            "sso_start_url = https://acme.awsapps.com/start",
            "sso_region = eu-west-1",
          ].join("\n"),
          [`${HOME}/.aws/sso/cache/${sha1("acme")}.json`]: JSON.stringify({
            accessToken: "sso-bearer",
            expiresAt: "2030-01-01T00:00:00Z",
          }),
        }),
        now: () => new Date("2026-10-12T00:00:00Z"),
        http: (url, init) => {
          portal.push({ url, headers: init.headers });
          return Promise.resolve({
            status: 200,
            text: JSON.stringify({
              roleCredentials: { accessKeyId: "ASIASSOKEY000000000", secretAccessKey: "ssosecret", sessionToken: "ssotoken" },
            }),
          });
        },
      },
    });
    expect(portal).toEqual([
      {
        url: "https://portal.sso.eu-west-1.amazonaws.com/federation/credentials?account_id=491500000000&role_name=Deployer",
        headers: { "x-amz-sso_bearer_token": "sso-bearer" },
      },
    ]);
    expect((result as { source: string }).source).toContain(
      "profile loom (sso session acme), role Deployer in 491500000000",
    );
    expect(sts.calls[0].headers.authorization).toContain("Credential=ASIASSOKEY000000000/");
    expect(sts.calls[0].headers["x-amz-security-token"]).toBe("ssotoken");
    const serialized = JSON.stringify(result);
    for (const secret of ["sso-bearer", "ssosecret", "ssotoken"]) expect(serialized).not.toContain(secret);
  });

  test("an expired SSO session is no-credentials naming aws sso login --profile", async () => {
    const { http, calls } = recording(CALLER_IDENTITY_XML);
    const portalCalls: string[] = [];
    const result = await whoami({
      environment: "prod",
      client: { http, env: { AWS_PROFILE: "loom" } },
      chain: {
        ...files({
          [`${HOME}/.aws/config`]:
            "[profile loom]\nsso_start_url = https://acme.awsapps.com/start\nsso_region = us-east-1\nsso_account_id = 491500000000\nsso_role_name = Deployer\n",
          [`${HOME}/.aws/sso/cache/${sha1("https://acme.awsapps.com/start")}.json`]: JSON.stringify({
            accessToken: "stale",
            expiresAt: "2026-01-01T00:00:00Z",
          }),
        }),
        now: () => new Date("2026-10-12T00:00:00Z"),
        http: (url) => {
          portalCalls.push(url);
          return Promise.resolve({ status: 200, text: "{}" });
        },
      },
    });
    expect(result).toEqual({
      unresolved: {
        reason: "no-credentials",
        detail: "profile loom: the SSO session has expired; run `aws sso login --profile loom`",
      },
    });
    expect(portalCalls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("a portal refusal of a cached session also names aws sso login", async () => {
    const { http } = recording(CALLER_IDENTITY_XML);
    const result = await whoami({
      environment: "prod",
      client: { http, env: {} },
      chain: {
        ...files({
          [`${HOME}/.aws/config`]:
            "[default]\nsso_session = acme\nsso_account_id = 1\nsso_role_name = R\n[sso-session acme]\nsso_start_url = https://a/start\nsso_region = us-east-1\n",
          [`${HOME}/.aws/sso/cache/${sha1("acme")}.json`]: JSON.stringify({
            accessToken: "revoked",
            expiresAt: "2030-01-01T00:00:00Z",
          }),
        }),
        now: () => new Date("2026-10-12T00:00:00Z"),
        http: () => Promise.resolve({ status: 401, text: '{"message":"Session token not found or invalid"}' }),
      },
    });
    expect(result).toMatchObject({ unresolved: { reason: "no-credentials" } });
    expect((result as { unresolved: { detail: string } }).unresolved.detail).toContain(
      "run `aws sso login --profile default`",
    );
  });

  test("an expired sso-session token with a refresh token is refreshed, not reported expired", async () => {
    const sts = recording(CALLER_IDENTITY_XML);
    const seen: string[] = [];
    const result = await whoami({
      environment: "prod",
      client: { http: sts.http, env: { AWS_PROFILE: "loom" } },
      chain: {
        ...files({
          [`${HOME}/.aws/config`]:
            "[profile loom]\nsso_session = acme\nsso_account_id = 491500000000\nsso_role_name = Deployer\n[sso-session acme]\nsso_start_url = https://a/start\nsso_region = us-east-1\n",
          [`${HOME}/.aws/sso/cache/${sha1("acme")}.json`]: JSON.stringify({
            accessToken: "stale",
            expiresAt: "2026-01-01T00:00:00Z",
            refreshToken: "refresh",
            clientId: "cid",
            clientSecret: "csecret",
            registrationExpiresAt: "2030-01-01T00:00:00Z",
          }),
        }),
        now: () => new Date("2026-10-12T00:00:00Z"),
        http: (url, init) => {
          seen.push(`${init.method} ${url}`);
          if (url.startsWith("https://oidc.")) {
            expect(JSON.parse(init.body ?? "{}")).toMatchObject({ grantType: "refresh_token", refreshToken: "refresh" });
            return Promise.resolve({ status: 200, text: JSON.stringify({ accessToken: "fresh", expiresIn: 3600 }) });
          }
          expect(init.headers["x-amz-sso_bearer_token"]).toBe("fresh");
          return Promise.resolve({
            status: 200,
            text: JSON.stringify({ roleCredentials: { accessKeyId: "ASIAX", secretAccessKey: "s", sessionToken: "t" } }),
          });
        },
      },
    });
    expect(seen).toEqual([
      "POST https://oidc.us-east-1.amazonaws.com/token",
      "GET https://portal.sso.us-east-1.amazonaws.com/federation/credentials?account_id=491500000000&role_name=Deployer",
    ]);
    expect(result).toMatchObject({ identity: "arn:aws:sts::491500000000:assumed-role/deploy/ci" });
  });

  test("credential_process output signs the call; a failing process is no-credentials without echoing output", async () => {
    const { http, calls } = recording(CALLER_IDENTITY_XML);
    const config = { [`${HOME}/.aws/config`]: "[profile vault]\ncredential_process = aws-vault exec ci --json\n" };
    const ran: string[] = [];
    const ok = await whoami({
      environment: "prod",
      client: { http, env: { AWS_PROFILE: "vault" } },
      chain: {
        ...files(config),
        runProcess: (command) => {
          ran.push(command);
          return Promise.resolve({
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({ Version: 1, AccessKeyId: "ASIAPROC00000000000", SecretAccessKey: "procsecret" }),
          });
        },
      },
    });
    expect(ran).toEqual(["aws-vault exec ci --json"]);
    expect((ok as { source: string }).source).toContain("profile vault (credential_process)");
    expect(calls[0].headers.authorization).toContain("Credential=ASIAPROC00000000000/");

    const bad = await whoami({
      environment: "prod",
      client: { http, env: { AWS_PROFILE: "vault" } },
      chain: {
        ...files(config),
        runProcess: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: '{"AccessKeyId":"ASIALEAK"' }),
      },
    });
    expect(bad).toMatchObject({ unresolved: { reason: "no-credentials" } });
    expect(JSON.stringify(bad)).not.toContain("ASIALEAK");
  });

  test("a role_arn profile assumes the role with its source profile's keys", async () => {
    const assumed = `<AssumeRoleResponse><AssumeRoleResult><Credentials>
      <AccessKeyId>ASIAROLE00000000000</AccessKeyId><SecretAccessKey>rolesecret</SecretAccessKey>
      <SessionToken>roletoken</SessionToken><Expiration>2030-01-01T00:00:00Z</Expiration>
    </Credentials></AssumeRoleResult></AssumeRoleResponse>`;
    const calls: Array<{ body: string; auth: string }> = [];
    const http: AwsReadHttp = (_url, init) => {
      calls.push({ body: init.body, auth: init.headers.authorization ?? "" });
      return Promise.resolve({ status: 200, text: init.body.includes("AssumeRole") ? assumed : CALLER_IDENTITY_XML });
    };
    const result = await whoami({
      environment: "prod",
      client: { http, env: { AWS_PROFILE: "deploy" } },
      chain: files({
        [`${HOME}/.aws/config`]:
          "[profile deploy]\nrole_arn = arn:aws:iam::491500000000:role/deploy\nsource_profile = base\nrole_session_name = ci\n",
        [`${HOME}/.aws/credentials`]: "[base]\naws_access_key_id = AKIABASE00000000000\naws_secret_access_key = basesecret\n",
      }),
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toContain("Action=AssumeRole");
    expect(calls[0].body).toContain("RoleSessionName=ci");
    expect(calls[0].auth).toContain("Credential=AKIABASE00000000000/");
    expect(calls[1].auth).toContain("Credential=ASIAROLE00000000000/");
    expect((result as { source: string }).source).toContain(
      "profile deploy (role arn:aws:iam::491500000000:role/deploy via profile base (static keys))",
    );
  });

  test("environment keys win over AWS_PROFILE, as in the AWS CLI, and the row says the profile was not used", async () => {
    const { http, calls } = recording(CALLER_IDENTITY_XML);
    const result = await whoami({
      environment: "prod",
      client: { http, env: { ...CREDS, AWS_PROFILE: "dev" } },
      chain: files({ [`${HOME}/.aws/credentials`]: "[dev]\naws_access_key_id = AKIAOTHER\naws_secret_access_key = x\n" }),
    });
    expect((result as { source: string }).source).toContain("env AWS_ACCESS_KEY_ID; AWS_PROFILE=dev not used");
    expect(calls[0].headers.authorization).toContain(`Credential=${CREDS.AWS_ACCESS_KEY_ID}/`);
  });

  test("the default profile answers when AWS_PROFILE is unset", async () => {
    const { http } = recording(CALLER_IDENTITY_XML);
    const result = await whoami({
      environment: "prod",
      client: { http, env: {} },
      chain: files({ [`${HOME}/.aws/credentials`]: "[default]\naws_access_key_id = AKIADEF\naws_secret_access_key = d\n" }),
    });
    expect((result as { source: string }).source).toContain("profile default (static keys)");
  });

  test("AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE move the files read", async () => {
    const { http } = recording(CALLER_IDENTITY_XML);
    const result = await whoami({
      environment: "prod",
      client: {
        http,
        env: { AWS_PROFILE: "x", AWS_CONFIG_FILE: "/etc/aws/config", AWS_SHARED_CREDENTIALS_FILE: "/etc/aws/creds" },
      },
      chain: files({ "/etc/aws/creds": "[x]\naws_access_key_id = AKIAX\naws_secret_access_key = s\n" }),
    });
    expect((result as { source: string }).source).toContain("profile x (static keys)");
  });
});

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}
