/**
 * #4549: a Pulumi Cloud identity in `ci.identity.cloud`. The plan and record
 * jobs trade the forge's OIDC token for a preview token, the apply jobs for
 * an up token, through Pulumi Cloud's OAuth token exchange. The trade tests
 * run the generated `node -e` line with `sh`, as a forge step runs it,
 * against the local emulator's fake exchange (./__fixtures__/oidc-emulator.ts).
 * Test values only; nothing reaches api.pulumi.com.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  CLOUDS,
  cloudIdentityProblems,
  gitlabTradeIdTokens,
  idTokenVar,
  IDENTITY_CLOUDS,
  OIDC_REQUEST_VARS,
  pulumiTokenRequest,
  resolveCloudIdentity,
  TRADE_SPEC_ENV,
  TRADED_VARS,
  tradeLine,
  type CloudIdentityDeclaration,
  type CloudTradeSpec,
} from "./ci-identity";
import { emulatedPulumiToken, EMULATED_JWT_PREFIX, startOidcEmulator, type OidcEmulator } from "./__fixtures__/oidc-emulator";

const run = promisify(execFile);

const DECL: CloudIdentityDeclaration = {
  pulumi: {
    organization: "acme",
    rules: [
      { environments: ["prod"], plan: "team:prod-preview", apply: "team:prod-deploy" },
      { plan: "user:ci-preview", apply: "organization:admin" },
    ],
  },
};

describe("which Pulumi Cloud tokens a pipeline takes (#4549)", () => {
  test("the plan trade names the preview token and the apply trade the up token, with the organization's audience", () => {
    const id = resolveCloudIdentity(DECL, "prod")!;
    expect(id.plan).toEqual({ pulumi: { token: "team:prod-preview", organization: "acme", audience: "urn:pulumi:org:acme" } });
    expect(id.apply).toEqual({ pulumi: { token: "team:prod-deploy", organization: "acme", audience: "urn:pulumi:org:acme" } });
    expect(resolveCloudIdentity(DECL, "staging")!.apply.pulumi!.token).toBe("organization:admin");
  });

  test("a declared audience and API URL are kept", () => {
    const id = resolveCloudIdentity({ pulumi: { ...DECL.pulumi!, audience: "acme", apiUrl: "https://pulumi.example.test" } }, "prod")!;
    expect(id.plan.pulumi).toMatchObject({ audience: "acme", apiUrl: "https://pulumi.example.test" });
  });

  test("CLOUDS stays the cloud providers; the identity keys add pulumi", () => {
    expect([...CLOUDS]).toEqual(["aws", "gcp", "azure"]);
    expect([...IDENTITY_CLOUDS]).toEqual(["aws", "gcp", "azure", "pulumi"]);
    expect(OIDC_REQUEST_VARS).toContain(idTokenVar("pulumi"));
    expect(TRADED_VARS.pulumi).toContain("PULUMI_ACCESS_TOKEN");
  });

  test("GitLab asks for one id token with the organization's audience", () => {
    expect(gitlabTradeIdTokens(resolveCloudIdentity(DECL, "prod")!.plan)).toEqual({ CHANT_ID_TOKEN_PULUMI: { aud: "urn:pulumi:org:acme" } });
  });

  test("an identity names a token the exchange can give", () => {
    expect(pulumiTokenRequest("team:deployers")).toEqual({ tokenType: "urn:pulumi:token-type:access_token:team", scope: "team:deployers" });
    expect(pulumiTokenRequest("user:ci-bot")).toEqual({ tokenType: "urn:pulumi:token-type:access_token:personal", scope: "user:ci-bot" });
    expect(pulumiTokenRequest("organization")).toEqual({ tokenType: "urn:pulumi:token-type:access_token:organization" });
    expect(pulumiTokenRequest("organization:admin")).toEqual({ tokenType: "urn:pulumi:token-type:access_token:organization", scope: "admin" });
    for (const bad of ["deployers", "team:", "team:a b", "org", "pul-abc123"]) expect(pulumiTokenRequest(bad), bad).toBeUndefined();
  });

  test("a rule whose identity is no token, or that previews with the up token, is a problem", () => {
    expect(cloudIdentityProblems(DECL)).toEqual([]);
    const bad = cloudIdentityProblems({ pulumi: { organization: "acme", rules: [{ plan: "deployers", apply: "team:deploy" }] } });
    expect(bad).toEqual([expect.objectContaining({ pointer: "/ci/identity/cloud/pulumi/rules/0/plan" })]);
    const same = cloudIdentityProblems({ pulumi: { organization: "acme", rules: [{ plan: "organization", apply: "organization" }] } });
    expect(same[0]!.message).toContain("plans and applies as organization");
  });
});

const dirs: string[] = [];
let emu: OidcEmulator;
beforeAll(async () => {
  emu = await startOidcEmulator();
});
afterAll(async () => {
  await emu.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const BASE = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" };

/** Run the trade line as a step does, with `spec` pointed at the emulator's fake exchange. */
async function trade(spec: CloudTradeSpec, format: "github-env" | "sh", env: Record<string, string> = emu.requestEnv): Promise<{ out: string; stdout: string; stderr: string; code: number; file: string }> {
  const dir = mkdtempSync(join(tmpdir(), "chant-pulumi-trade-"));
  dirs.push(dir);
  const file = join(dir, format === "sh" ? "cloud.sh" : "github-env");
  if (format === "github-env") writeFileSync(file, "EARLIER=1\n");
  try {
    const r = await run("sh", ["-c", tradeLine(file, format)], { env: { ...BASE, ...env, [TRADE_SPEC_ENV]: JSON.stringify(emu.pointAt(spec)) } });
    return { out: existsSync(file) ? readFileSync(file, "utf-8") : "", stdout: r.stdout, stderr: r.stderr, code: 0, file };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { out: existsSync(file) ? readFileSync(file, "utf-8") : "", stdout: err.stdout, stderr: err.stderr, code: err.code, file };
  }
}

describe("the Pulumi Cloud trade, run against the fake exchange (#4549)", () => {
  const prod = () => resolveCloudIdentity(DECL, "prod")!;

  test("the plan job's trade gets the preview token alone, masked, in PULUMI_ACCESS_TOKEN", async () => {
    const before = { minted: emu.log.minted.length, pulumi: emu.log.pulumi.length };
    const r = await trade(prod().plan, "github-env");
    expect(r.stderr).not.toContain("failed");
    expect(r.code).toBe(0);
    const preview = emulatedPulumiToken("team:prod-preview");
    expect(r.out).toContain(`PULUMI_ACCESS_TOKEN=${preview}\n`);
    expect(r.out).toContain(`PULUMI_BACKEND_URL=${emu.url}/pulumi\n`);
    expect(r.stdout).toContain(`::add-mask::${preview}`);
    expect(r.out).not.toContain(emulatedPulumiToken("team:prod-deploy"));
    expect(r.out + r.stdout + r.stderr).not.toContain(EMULATED_JWT_PREFIX);
    expect(emu.log.minted.slice(before.minted)).toEqual(["urn:pulumi:org:acme"]);
    expect(emu.log.pulumi.slice(before.pulumi).map((x) => ({ tokenType: x.tokenType, scope: x.scope, audience: x.audience }))).toEqual([
      { tokenType: "urn:pulumi:token-type:access_token:team", scope: "team:prod-preview", audience: "urn:pulumi:org:acme" },
    ]);
  });

  test("the apply job's trade gets the up token", async () => {
    const r = await trade(prod().apply, "sh");
    expect(r.code).toBe(0);
    const probe = await run("sh", ["-c", `. "${r.file}"; echo "$PULUMI_ACCESS_TOKEN"`], { env: BASE });
    expect(probe.stdout.trim()).toBe(emulatedPulumiToken("team:prod-deploy"));
  });

  test("an organization admin token asks for the organization token type with the admin scope", async () => {
    const before = emu.log.pulumi.length;
    const r = await trade(resolveCloudIdentity(DECL, "staging")!.apply, "sh");
    expect(r.code).toBe(0);
    expect(emu.log.pulumi.slice(before).map((x) => [x.tokenType, x.scope])).toEqual([["urn:pulumi:token-type:access_token:organization", "admin"]]);
  });

  test("on GitLab the token comes from CHANT_ID_TOKEN_PULUMI, and no request URL is needed", async () => {
    const before = emu.log.minted.length;
    const jwt = `${EMULATED_JWT_PREFIX}.gitlab.pulumi`;
    const r = await trade(prod().plan, "sh", { [idTokenVar("pulumi")]: jwt });
    expect(r.code).toBe(0);
    expect(emu.log.minted.length).toBe(before);
    expect(emu.log.pulumi.at(-1)!.token).toBe(jwt);
    expect(r.out).not.toContain(jwt);
  });

  test("an identity the exchange has no token for fails the step and writes nothing", async () => {
    const r = await trade({ pulumi: { ...prod().plan.pulumi!, token: "deployers" } }, "sh");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Pulumi Cloud has no token for deployers");
    expect(r.out).toBe("");
  });
});
