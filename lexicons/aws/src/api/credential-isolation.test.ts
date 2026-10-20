/**
 * The unit project keeps the developer's ~/.aws out of reach (#3958).
 * test/aws-credential-isolation.setup.ts strips the credential variables and
 * points the shared files at paths that do not exist. These tests put a
 * `credential_process` profile under a HOME that the chain would otherwise
 * read and check that a read with no injected `env` never runs it.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeStackResources, type AwsReadHttp } from "./read-client";
import { resetTransportCredentials, resolveCredentialChain, transportCredentials } from "./credential-chain";

const stackXml =
  "<DescribeStackResourcesResponse><DescribeStackResourcesResult><StackResources></StackResources>" +
  "</DescribeStackResourcesResult></DescribeStackResourcesResponse>";

let home: string;
let marker: string;
let savedHome: string | undefined;

beforeEach(() => {
  resetTransportCredentials();
  home = mkdtempSync(join(tmpdir(), "chant-aws-isolation-"));
  marker = join(home, "credential-process-ran");
  mkdirSync(join(home, ".aws"));
  // The command writes the marker and prints nothing, so the chain refuses its
  // output; the marker alone says whether it ran.
  writeFileSync(join(home, ".aws", "config"), `[default]\ncredential_process = touch '${marker}'\n`);
  savedHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  resetTransportCredentials();
});

describe("unit tests do not read the real AWS shared files (#3958)", () => {
  test("the setup file cleared the credential variables and pointed the shared files nowhere", () => {
    for (const name of ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) {
      expect(process.env[name]).toBeUndefined();
    }
    expect(process.env.AWS_CONFIG_FILE).toBeTruthy();
    expect(existsSync(process.env.AWS_CONFIG_FILE!)).toBe(false);
    expect(process.env.AWS_SHARED_CREDENTIALS_FILE).toBeTruthy();
    expect(existsSync(process.env.AWS_SHARED_CREDENTIALS_FILE!)).toBe(false);
  });

  test("a read with no injected env goes out unsigned and runs no credential_process", async () => {
    const auth: string[] = [];
    const http: AwsReadHttp = async (_url, init) => {
      auth.push(init.headers.authorization ?? "");
      return { status: 200, text: stackXml };
    };
    await describeStackResources("app", { http, region: "us-east-1" });
    expect(auth[0]).toContain("Signature=unsigned");
    expect(await transportCredentials()).toBeUndefined();
    const chain = await resolveCredentialChain();
    expect("unresolved" in chain).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  test("control: the same HOME injected without the setup's file paths does run the command", async () => {
    const result = await resolveCredentialChain({ env: { HOME: home } });
    expect("unresolved" in result).toBe(true);
    expect(existsSync(marker)).toBe(true);
  });
});
