/**
 * #4296: the plan and apply cloud identities, and the OIDC trade. The trade
 * tests run the generated `node -e` line with `sh`, as a forge step runs
 * it, against a local emulator of the forge's token URL, AWS STS, Google's
 * STS and IAM credentials, and Entra (./__fixtures__/oidc-emulator.ts).
 * Test values only; no cloud is reached.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  cloudIdentityProblems,
  gitlabTradeIdTokens,
  gitlabTradeLines,
  idTokenVar,
  OIDC_REQUEST_VARS,
  resolveCloudIdentity,
  TRADE_JS,
  TRADE_SPEC_ENV,
  tradeLine,
  type CloudIdentityDeclaration,
  type CloudTradeSpec,
} from "./ci-identity";
import { emulatedCredentials, EMULATED_JWT_PREFIX, startOidcEmulator, type OidcEmulator } from "./__fixtures__/oidc-emulator";
import { dropForgeTokens } from "./ci-handover";

const run = promisify(execFile);

const DECL: CloudIdentityDeclaration = {
  aws: {
    region: "eu-west-1",
    rules: [
      { environments: ["prod"], members: ["net"], plan: "arn:aws:iam::111111111111:role/net-prod-plan", apply: "arn:aws:iam::111111111111:role/net-prod-apply" },
      { environments: ["prod"], plan: "arn:aws:iam::111111111111:role/prod-plan", apply: "arn:aws:iam::111111111111:role/prod-apply" },
      { environments: ["staging-*"], plan: "arn:aws:iam::222222222222:role/staging-plan", apply: "arn:aws:iam::222222222222:role/staging-apply" },
    ],
  },
  gcp: {
    provider: "projects/123/locations/global/workloadIdentityPools/ci/providers/forge",
    rules: [{ plan: "plan@test-project.iam.gserviceaccount.com", apply: "apply@test-project.iam.gserviceaccount.com" }],
  },
  azure: { tenantId: "00000000-0000-0000-0000-00000000tena", rules: [{ members: ["app"], plan: "plan-client-id", apply: "apply-client-id" }] },
};

describe("which identities a pipeline takes (#4296)", () => {
  test("the first rule whose environments and members match wins, per cloud", () => {
    const net = resolveCloudIdentity(DECL, "prod", "net")!;
    expect(net.plan.aws!.role).toBe("arn:aws:iam::111111111111:role/net-prod-plan");
    expect(net.apply.aws!.role).toBe("arn:aws:iam::111111111111:role/net-prod-apply");
    expect(resolveCloudIdentity(DECL, "prod", "web")!.plan.aws!.role).toBe("arn:aws:iam::111111111111:role/prod-plan");
    expect(resolveCloudIdentity(DECL, "staging-eu", "net")!.apply.aws!.role).toBe("arn:aws:iam::222222222222:role/staging-apply");
    expect(net.plan.aws).toMatchObject({ region: "eu-west-1", audience: "sts.amazonaws.com" });
  });

  test("a cloud no rule covers is left out, and so is a pipeline no rule covers", () => {
    expect(resolveCloudIdentity(DECL, "prod", "net")!.plan.azure).toBeUndefined();
    expect(resolveCloudIdentity(DECL, "prod", "app")!.plan.azure).toMatchObject({ clientId: "plan-client-id", audience: "api://AzureADTokenExchange" });
    expect(resolveCloudIdentity({ aws: DECL.aws }, "dev", "net")).toBeUndefined();
    expect(resolveCloudIdentity(undefined, "prod")).toBeUndefined();
  });

  test("a rule with members never matches a pipeline outside a member", () => {
    expect(resolveCloudIdentity(DECL, "prod")!.plan.aws!.role).toBe("arn:aws:iam::111111111111:role/prod-plan");
  });

  test("GCP's default audience names the provider", () => {
    expect(resolveCloudIdentity(DECL, "prod")!.plan.gcp!.audience).toBe("https://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/ci/providers/forge");
  });

  test("a rule may not plan as an identity it or another rule applies as", () => {
    expect(cloudIdentityProblems(DECL)).toEqual([]);
    const same = cloudIdentityProblems({ aws: { rules: [{ plan: "r", apply: "r" }] } });
    expect(same).toEqual([{ pointer: "/ci/identity/cloud/aws/rules/0", message: expect.stringContaining("plans and applies as r") }]);
    const crossed = cloudIdentityProblems({ gcp: { provider: "p", rules: [{ plan: "a", apply: "b" }, { plan: "b", apply: "c" }] } });
    expect(crossed).toEqual([{ pointer: "/ci/identity/cloud/gcp/rules/1", message: expect.stringContaining("plans as b, which another rule applies as") }]);
  });
});

describe("the trade script stays inside one shell word", () => {
  test("it holds no single quote, so tradeLine can quote it", () => {
    expect(TRADE_JS).not.toContain("'");
  });
  test("GitLab's lines trade, unset the token variables and the extra ones, then source the credentials", () => {
    const [trade, unset, source] = gitlabTradeLines(["CHANT_FORGE_TOKEN"]);
    expect(trade).toContain("node -e");
    expect(unset).toBe(`unset CHANT_FORGE_TOKEN ${OIDC_REQUEST_VARS.join(" ")}`);
    expect(source).toMatch(/^\. "\$\{TMPDIR:-\/tmp\}\/chant-cloud-\$CI_JOB_ID\.sh" && rm -f /);
    expect(gitlabTradeIdTokens(resolveCloudIdentity(DECL, "prod", "app")!.plan)).toEqual({
      CHANT_ID_TOKEN_AWS: { aud: "sts.amazonaws.com" },
      CHANT_ID_TOKEN_GCP: { aud: "https://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/ci/providers/forge" },
      CHANT_ID_TOKEN_AZURE: { aud: "api://AzureADTokenExchange" },
    });
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

/** Run the trade line as a step does, with `spec` pointed at the emulator. */
async function trade(spec: CloudTradeSpec, format: "github-env" | "sh", env: Record<string, string> = emu.requestEnv): Promise<{ out: string; stdout: string; stderr: string; code: number; file: string }> {
  const dir = mkdtempSync(join(tmpdir(), "chant-trade-"));
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

describe("the trade, run against the emulator (#4296)", () => {
  const prodApp = () => resolveCloudIdentity(DECL, "prod", "app")!;

  test("it trades one minted token per cloud for the plan identity alone, and writes the credentials to GITHUB_ENV", async () => {
    const before = { minted: emu.log.minted.length, assumed: emu.log.assumed.length };
    const r = await trade(prodApp().plan, "github-env");
    expect(r.stderr).not.toContain("failed");
    expect(r.code).toBe(0);
    const aws = emulatedCredentials("arn:aws:iam::111111111111:role/prod-plan");
    expect(r.out).toContain("EARLIER=1\n");
    expect(r.out).toContain(`AWS_ACCESS_KEY_ID=${aws.accessKeyId}\n`);
    expect(r.out).toContain(`AWS_SESSION_TOKEN=${aws.token}\n`);
    expect(r.out).toContain("AWS_REGION=eu-west-1\n");
    expect(r.out).toMatch(/^GOOGLE_OAUTH_ACCESS_TOKEN=ya29\.session-/m);
    expect(r.out).toMatch(/^AZURE_ACCESS_TOKEN=azure\.session-/m);
    expect(r.out).toContain("AZURE_CLIENT_ID=plan-client-id\n");
    // The minted token itself is in no line the later steps get, and no apply identity was asked for.
    expect(r.out).not.toContain(EMULATED_JWT_PREFIX);
    expect(r.stdout + r.stderr).not.toContain(EMULATED_JWT_PREFIX);
    expect(emu.log.minted.slice(before.minted)).toEqual(["sts.amazonaws.com", "https://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/ci/providers/forge", "api://AzureADTokenExchange"]);
    expect(emu.log.assumed.slice(before.assumed).map((a) => a.role)).toEqual(["arn:aws:iam::111111111111:role/prod-plan"]);
    expect(emu.log.impersonated.at(-1)).toBe("plan@test-project.iam.gserviceaccount.com");
    expect(emu.log.clients.at(-1)!.clientId).toBe("plan-client-id");
    // GitHub masks each secret in every later step's log.
    expect(r.stdout).toContain(`::add-mask::${aws.secret}`);
    expect(r.stdout).toContain(`::add-mask::${aws.token}`);
  });

  test("the sh format writes export lines a GitLab script sources, mode 0600", async () => {
    const r = await trade({ aws: prodApp().apply.aws }, "sh");
    expect(r.code).toBe(0);
    expect(statSync(r.file).mode & 0o777).toBe(0o600);
    const probe = await run("sh", ["-c", `. "${r.file}"; echo "$AWS_ACCESS_KEY_ID"`], { env: BASE });
    expect(probe.stdout.trim()).toBe(emulatedCredentials("arn:aws:iam::111111111111:role/prod-apply").accessKeyId);
  });

  test("on GitLab the token comes from the job's id_tokens variable, and no request URL is needed", async () => {
    const before = emu.log.minted.length;
    const jwt = `${EMULATED_JWT_PREFIX}.gitlab.1`;
    const r = await trade({ aws: prodApp().plan.aws }, "sh", { [idTokenVar("aws")]: jwt });
    expect(r.code).toBe(0);
    expect(emu.log.minted.length).toBe(before);
    expect(emu.log.assumed.at(-1)).toEqual({ role: "arn:aws:iam::111111111111:role/prod-plan", token: jwt });
    expect(r.out).not.toContain(jwt);
  });

  test("a job that can request no token fails the step and writes nothing", async () => {
    const r = await trade({ aws: prodApp().plan.aws }, "sh", {});
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("the job can request no OIDC token for aws");
    expect(r.out).toBe("");
  });

  test("an answer that would add a line of its own to GITHUB_ENV is refused", async () => {
    const r = await trade({ aws: { ...prodApp().plan.aws!, region: "eu-west-1\nNODE_OPTIONS=--require=/tmp/x" } }, "github-env");
    expect(r.code).not.toBe(0);
    expect(r.out).toBe("EARLIER=1\n");
  });
});

describe("after the trade, a step that runs the change's code cannot request a token (#4296)", () => {
  test("the drop line with the OIDC request variables leaves none of them, and a request from the step fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-trade-drop-"));
    dirs.push(dir);
    const file = join(dir, "step.sh");
    const ask = `node -e 'const u=process.env.ACTIONS_ID_TOKEN_REQUEST_URL,k=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;if(!u||!k){console.log("no-request-vars");process.exit(0)}fetch(u+"&audience=sts.amazonaws.com",{headers:{authorization:"bearer "+k}}).then(r=>r.text()).then(t=>console.log("minted:"+t))'`;
    writeFileSync(file, `${dropForgeTokens("sh", OIDC_REQUEST_VARS)}\nenv\n${ask}\n`);
    const before = emu.log.minted.length;
    const r = await run("sh", ["-e", file], { cwd: dir, env: { ...BASE, ...emu.requestEnv, [idTokenVar("aws")]: `${EMULATED_JWT_PREFIX}.x.y`, [TRADE_SPEC_ENV]: "{}" } });
    expect(r.stdout).toContain("no-request-vars");
    expect(r.stdout).not.toContain(EMULATED_JWT_PREFIX);
    for (const v of OIDC_REQUEST_VARS) expect(r.stdout).not.toMatch(new RegExp(`^${v}=`, "m"));
    expect(emu.log.minted.length).toBe(before);
  });
});
