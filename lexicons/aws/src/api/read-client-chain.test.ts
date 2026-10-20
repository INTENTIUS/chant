/**
 * The read transport signs with the AWS CLI's credential chain (#3958), the
 * same walk `chant lifecycle whoami` does (#3954). Shared files live in a temp
 * directory and HTTP is injected, so nothing reads the real `~/.aws` or
 * reaches a network.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeStackResources, getCallerIdentity, type AwsReadHttp } from "./read-client";
import { resetTransportCredentials, transportCredentials, TRANSPORT_REFRESH_MARGIN_MS } from "./credential-chain";
import { ssmCall } from "../receipt-store";

const stackXml =
  "<DescribeStackResourcesResponse><DescribeStackResourcesResult><StackResources></StackResources>" +
  "</DescribeStackResourcesResult></DescribeStackResourcesResponse>";

function recording(text: (url: string, body: string) => string) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const http: AwsReadHttp = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { status: 200, text: text(url, init.body) };
  };
  return { http, calls };
}

let home: string;
beforeEach(() => {
  resetTransportCredentials();
  home = mkdtempSync(join(tmpdir(), "chant-aws-chain-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  resetTransportCredentials();
});

function writeAws(config: string, credentials = ""): Record<string, string> {
  const configPath = join(home, "config");
  const credentialsPath = join(home, "credentials");
  writeFileSync(configPath, config);
  writeFileSync(credentialsPath, credentials);
  return { HOME: home, AWS_CONFIG_FILE: configPath, AWS_SHARED_CREDENTIALS_FILE: credentialsPath };
}

describe("the read transport walks the credential chain (#3958)", () => {
  test("AWS_PROFILE with static keys in the shared credentials file signs a CloudFormation read", async () => {
    const env = { ...writeAws("[profile dev]\nregion = eu-west-1\n", "[dev]\naws_access_key_id = AKIDPROFILE\naws_secret_access_key = secret\n"), AWS_PROFILE: "dev" };
    const { http, calls } = recording(() => stackXml);
    await describeStackResources("app", { http, env, region: "eu-west-1" });
    const auth = calls[0]!.headers.authorization ?? "";
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDPROFILE\/\d{8}\/eu-west-1\/cloudformation\/aws4_request/);
    expect(auth).not.toContain("Signature=unsigned");
    expect(calls[0]!.headers["x-amz-date"]).toBeDefined();
  });

  test("the default profile signs when AWS_PROFILE is unset, and the SSM receipt store signs too", async () => {
    const env = writeAws("", "[default]\naws_access_key_id = AKIDDEFAULT\naws_secret_access_key = secret\naws_session_token = tok\n");
    const { http, calls } = recording(() => "{}");
    await ssmCall("GetParameter", { Name: "/x" }, { http, env });
    expect(calls[0]!.headers.authorization).toMatch(/Credential=AKIDDEFAULT\/.*\/ssm\/aws4_request/);
    expect(calls[0]!.headers["x-amz-security-token"]).toBe("tok");
  });

  test("a role_arn profile assumes the role once and signs later reads with the role's keys", async () => {
    const env = {
      ...writeAws(
        "[profile ops]\nrole_arn = arn:aws:iam::111122223333:role/ops\nsource_profile = base\n",
        "[base]\naws_access_key_id = AKIDBASE\naws_secret_access_key = secret\n",
      ),
      AWS_PROFILE: "ops",
    };
    const expiration = new Date(Date.now() + 3600_000).toISOString();
    const { http, calls } = recording((_url, body) =>
      body.includes("Action=AssumeRole")
        ? `<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>ASIAROLE</AccessKeyId><SecretAccessKey>s</SecretAccessKey><SessionToken>t</SessionToken><Expiration>${expiration}</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>`
        : body.includes("GetCallerIdentity")
          ? "<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:sts::111122223333:assumed-role/ops/x</Arn><Account>111122223333</Account></GetCallerIdentityResult></GetCallerIdentityResponse>"
          : stackXml,
    );
    await Promise.all([describeStackResources("a", { http, env }), describeStackResources("b", { http, env })]);
    await getCallerIdentity({ http, env });
    const assume = calls.filter((c) => c.body.includes("Action=AssumeRole"));
    expect(assume).toHaveLength(1);
    expect(assume[0]!.headers.authorization).toContain("Credential=AKIDBASE/");
    const reads = calls.filter((c) => !c.body.includes("Action=AssumeRole"));
    expect(reads).toHaveLength(3);
    for (const r of reads) expect(r.headers.authorization).toContain("Credential=ASIAROLE/");
  });

  test("environment keys still win over AWS_PROFILE", async () => {
    const env = {
      ...writeAws("", "[dev]\naws_access_key_id = AKIDPROFILE\naws_secret_access_key = secret\n"),
      AWS_PROFILE: "dev",
      AWS_ACCESS_KEY_ID: "AKIDENV",
      AWS_SECRET_ACCESS_KEY: "secret",
    };
    const { http, calls } = recording(() => stackXml);
    await describeStackResources("app", { http, env });
    expect(calls[0]!.headers.authorization).toContain("Credential=AKIDENV/");
  });

  test("an endpoint override stays unsigned and the chain is not walked", async () => {
    const env = { ...writeAws("[profile tool]\ncredential_process = definitely-not-a-command\n"), AWS_PROFILE: "tool" };
    const { http, calls } = recording(() => stackXml);
    await describeStackResources("app", { http, env, endpoint: "http://localhost:4566", region: "us-west-1" });
    expect(calls[0]!.headers.authorization).toContain("Signature=unsigned");
  });

  test("an injected environment that names no shared files does not read the process's ~/.aws", async () => {
    const { http, calls } = recording(() => stackXml);
    await describeStackResources("app", { http, env: {}, region: "us-east-1" });
    expect(calls[0]!.headers.authorization).toContain("Signature=unsigned");
  });

  test("a profile that does not resolve leaves the read unsigned, as before", async () => {
    const env = { ...writeAws("[profile s]\nsso_start_url = https://a/start\nsso_region = us-east-1\nsso_account_id = 1\nsso_role_name = R\n"), AWS_PROFILE: "s" };
    const { http, calls } = recording(() => stackXml);
    await describeStackResources("app", { http, env, region: "us-east-1" });
    expect(calls[0]!.headers.authorization).toContain("Signature=unsigned");
  });
});

describe("transportCredentials caching", () => {
  test("credentials are resolved once and walked again within the refresh margin of their expiry", async () => {
    const env = { ...writeAws("[profile tool]\ncredential_process = issue\n"), AWS_PROFILE: "tool" };
    let t = Date.parse("2026-10-19T12:00:00Z");
    const expires = t + 3600_000;
    let runs = 0;
    const runProcess = async () => {
      runs++;
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ Version: 1, AccessKeyId: `AKID${runs}`, SecretAccessKey: "s", Expiration: new Date(expires + (runs - 1) * 3600_000).toISOString() }),
      };
    };
    const options = { env, runProcess, now: () => new Date(t) };
    expect((await transportCredentials(options))?.accessKeyId).toBe("AKID1");
    t = expires - TRANSPORT_REFRESH_MARGIN_MS - 1;
    expect((await transportCredentials(options))?.accessKeyId).toBe("AKID1");
    expect(runs).toBe(1);
    t = expires - TRANSPORT_REFRESH_MARGIN_MS + 1;
    expect((await transportCredentials(options))?.accessKeyId).toBe("AKID2");
    expect(runs).toBe(2);
  });

  test("concurrent first calls share one walk", async () => {
    const env = { ...writeAws("[profile tool]\ncredential_process = issue\n"), AWS_PROFILE: "tool" };
    let runs = 0;
    const runProcess = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 10));
      return { exitCode: 0, stderr: "", stdout: JSON.stringify({ Version: 1, AccessKeyId: "AKID", SecretAccessKey: "s" }) };
    };
    await Promise.all([1, 2, 3].map(() => transportCredentials({ env, runProcess })));
    expect(runs).toBe(1);
  });
});
