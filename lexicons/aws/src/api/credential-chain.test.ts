/**
 * The shared-file parser and the refusals of the credential chain (#3954).
 * Every seam is injected; nothing reads `~/.aws` or reaches a network.
 */
import { describe, test, expect } from "vitest";
import { parseIni, resolveCredentialChain } from "./credential-chain";

const HOME = "/home/op";
const files = (config: string) => ({
  home: HOME,
  readFile: (path: string) => (path === `${HOME}/.aws/config` ? config : undefined),
});

describe("parseIni", () => {
  test("reads sections and keys, skips comments and nested settings, keeps ; and # inside values", () => {
    const parsed = parseIni(
      [
        "# a comment",
        "[default]",
        "region = eu-west-1",
        "s3 =",
        "  max_concurrent_requests = 10",
        "output = json",
        "",
        "[profile  tool]",
        "; another comment",
        "credential_process = sh -c 'a; b # c'",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      default: { region: "eu-west-1", output: "json" },
      "profile tool": { credential_process: "sh -c 'a; b # c'" },
    });
  });
});

describe("resolveCredentialChain refusals", () => {
  test("a source_profile loop is refused, not followed forever", async () => {
    const result = await resolveCredentialChain({
      env: { AWS_PROFILE: "a" },
      ...files("[profile a]\nrole_arn = arn:aws:iam::1:role/a\nsource_profile = b\n[profile b]\nrole_arn = arn:aws:iam::1:role/b\nsource_profile = a\n"),
    });
    expect(result).toEqual({
      unresolved: { reason: "no-credentials", detail: "profile a: source_profile loops (a -> b -> a)" },
    });
  });

  test("mfa_serial and web identity profiles say what chant does not resolve", async () => {
    const mfa = await resolveCredentialChain({
      env: { AWS_PROFILE: "m" },
      ...files("[profile m]\nrole_arn = arn:aws:iam::1:role/m\nsource_profile = m2\nmfa_serial = arn:aws:iam::1:mfa/me\n"),
    });
    expect(mfa).toMatchObject({ unresolved: { detail: expect.stringContaining("mfa_serial") } });
    const web = await resolveCredentialChain({
      env: { AWS_PROFILE: "w" },
      ...files("[profile w]\nweb_identity_token_file = /tmp/t\nrole_arn = x\n"),
    });
    expect(web).toMatchObject({ unresolved: { reason: "no-credentials" } });
  });

  test("an SSO profile with no cached token names aws sso login", async () => {
    const result = await resolveCredentialChain({
      env: { AWS_PROFILE: "s" },
      ...files("[profile s]\nsso_start_url = https://a/start\nsso_region = us-east-1\nsso_account_id = 1\nsso_role_name = R\n"),
    });
    expect(result).toMatchObject({
      unresolved: { reason: "no-credentials", detail: expect.stringContaining("run `aws sso login --profile s`") },
    });
  });
});
