/**
 * #4788: cloud login steps from the OIDC token file, per forge and cloud.
 * The shell tests run the rendered step's lines with bash, as a forge runs
 * a step, against the local emulator of the forge's token URL
 * (./__fixtures__/oidc-emulator.ts). The login calls no cloud: the cloud's
 * own tools trade the token file later, so the tests check the files and
 * variables those tools read. Test values only; no cloud is reached.
 */

import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cloudLogin, cloudLoginSpec, forgejoCloudLogin, githubCloudLogin, GITLAB_LOGIN_VARS, gitlabCloudLogin, LOGIN_JS, LOGIN_SPEC_ENV, type CloudLoginSpec, type LoginForge } from "./ci-login";
import { CLOUD_TARGETS_ENV, CLOUD_TRADED_ENV, cloudsTraded, resolveCloudIdentity, targetCloudEnv, TRADE_SPEC_ENV, tradeLine, type CloudIdentityDeclaration, type CloudTradeSpec } from "./ci-identity";
import { EMULATED_JWT_PREFIX, startOidcEmulator, type OidcEmulator } from "./__fixtures__/oidc-emulator";

const run = promisify(execFile);

const PROVIDER = "projects/123/locations/global/workloadIdentityPools/ci/providers/forge";
const TENANT = "00000000-0000-0000-0000-000000000001";
const SPEC: CloudLoginSpec = {
  aws: { role: "arn:aws:iam::111111111111:role/plan", region: "eu-west-1", sessionName: "terragucci-plan" },
  gcp: { serviceAccount: "plan@proj.iam.gserviceaccount.com", provider: PROVIDER },
  azure: { clientId: "11111111-1111-1111-1111-111111111111", tenantId: TENANT, subscriptionId: "22222222-2222-2222-2222-222222222222" },
};
const AUD = { aws: "sts.amazonaws.com", gcp: `https://iam.googleapis.com/${PROVIDER}`, azure: "api://AzureADTokenExchange" };
const FORGES: LoginForge[] = ["github", "gitlab", "forgejo"];

describe("the rendered login (#4788)", () => {
  test("one function per forge, each one step that runs the login from / and names its clouds", () => {
    expect(githubCloudLogin(SPEC)).toEqual(cloudLogin("github", SPEC));
    expect(forgejoCloudLogin(SPEC)).toEqual(cloudLogin("forgejo", SPEC));
    expect(gitlabCloudLogin(SPEC)).toEqual(cloudLogin("gitlab", SPEC));
    for (const forge of FORGES) {
      const { steps } = cloudLogin(forge, SPEC);
      expect(steps).toHaveLength(1);
      expect(steps[0]!.name).toBe("Cloud login (chant ci-login: aws, gcp, azure)");
      expect(steps[0]!.run[0]).toMatch(new RegExp(`^export ${LOGIN_SPEC_ENV}='\\{`));
      expect(steps[0]!.run[1]).toMatch(new RegExp(`\\(cd / && node -e '.*' ".*" (github-env|sh) ${forge}\\)"?$`));
    }
    expect(githubCloudLogin(SPEC).steps[0]!.run[1]).toContain('"$GITHUB_ENV" github-env github');
    expect(forgejoCloudLogin(SPEC).steps[0]!.run[1]).toContain('"$GITHUB_ENV" github-env forgejo');
    const gitlab = gitlabCloudLogin(SPEC).steps[0]!.run;
    expect(gitlab[1]).toMatch(/^CHANT_CLOUD_LOGIN_VARS="\$\(cd \/ && node -e '.*' "-" sh gitlab\)"$/);
    expect(gitlab.slice(2)).toEqual(['eval "$CHANT_CLOUD_LOGIN_VARS"', `unset CHANT_CLOUD_LOGIN_VARS ${LOGIN_SPEC_ENV} CHANT_ID_TOKEN_AWS CHANT_ID_TOKEN_GCP CHANT_ID_TOKEN_AZURE`]);
  });

  test.each(["aws", "gcp", "azure"] as const)("%s: each forge's job requests the cloud's token with the cloud's audience", (cloud) => {
    for (const forge of FORGES) {
      expect(cloudLogin(forge, { [cloud]: SPEC[cloud] }).idTokens).toEqual({ [`CHANT_ID_TOKEN_${cloud.toUpperCase()}`]: AUD[cloud] });
      expect(cloudLogin(forge, { [cloud]: { ...SPEC[cloud], audience: "custom" } }).idTokens).toEqual({ [`CHANT_ID_TOKEN_${cloud.toUpperCase()}`]: "custom" });
    }
  });

  test("a cloud with a tokenFile the runner provides requests no token", () => {
    expect(forgejoCloudLogin({ aws: { ...SPEC.aws!, tokenFile: "$RUNNER_TEMP/aws-token" }, gcp: SPEC.gcp }).idTokens).toEqual({ CHANT_ID_TOKEN_GCP: AUD.gcp });
  });

  test("no cloud, no step", () => {
    for (const forge of FORGES) expect(cloudLogin(forge, {})).toEqual({ steps: [], idTokens: {} });
  });

  test("the script has no single quote, so it sits in one shell word", () => {
    expect(LOGIN_JS).not.toContain("'");
  });

  test("a stage's identities come from resolveCloudIdentity, as the trade's do", () => {
    const decl: CloudIdentityDeclaration = { aws: { region: "eu-west-1", rules: [{ plan: "arn:aws:iam::1:role/p", apply: "arn:aws:iam::1:role/a" }] } };
    const both = resolveCloudIdentity(decl, "prod")!;
    expect(JSON.parse(githubCloudLogin(both.plan).steps[0]!.run[0]!.slice(`export ${LOGIN_SPEC_ENV}=`.length).slice(1, -1))).toEqual({ aws: { role: "arn:aws:iam::1:role/p", region: "eu-west-1", audience: "sts.amazonaws.com" } });
    expect(githubCloudLogin(both.apply).steps[0]!.run[0]).toContain("role/a");
  });

  test("what a login cannot do is refused", () => {
    expect(() => githubCloudLogin({ pulumi: { organization: "o", audience: "a", token: "team:x" } } as unknown as CloudLoginSpec)).toThrow(/Pulumi Cloud\) is traded/);
    expect(() => githubCloudLogin({ azure: { ...SPEC.azure!, database: true } } as unknown as CloudLoginSpec)).toThrow(/no database token/);
    expect(() => githubCloudLogin({ aws: { role: "arn:aws:iam::1:role/a b" } })).toThrow(/role is .*printable ASCII with no space/);
    expect(() => githubCloudLogin({ azure: { tenantId: TENANT } })).toThrow(/names no identity/);
    expect(() => githubCloudLogin({ aws: { role: "r", sessionName: "x" } })).toThrow(/sessionName/);
    expect(() => githubCloudLogin({ aws: { role: "r", tokenFile: "$(id)" } })).toThrow(/tokenFile/);
    expect(() => githubCloudLogin({ azure: { tenantId: TENANT, targets: [{ targets: ["a"], clientId: "c" }], cli: true } })).toThrow(/needs clientId/);
  });
});

describe("the login, run (#4788)", () => {
  let emu: OidcEmulator;
  beforeAll(async () => {
    emu = await startOidcEmulator();
  });
  afterAll(async () => {
    await emu.close();
  });

  const parseEnvFile = (text: string): Record<string, string> => Object.fromEntries(text.trim().split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

  /** Runs an Actions step's lines with bash -e, as a GitHub or Forgejo step; gives $GITHUB_ENV's variables. */
  async function actionsStep(forge: "github" | "forgejo", spec: CloudLoginSpec, env: Record<string, string> = emu.requestEnv) {
    const dir = mkdtempSync(join(tmpdir(), "chant-login-"));
    const githubEnv = join(dir, "github-env");
    writeFileSync(githubEnv, "");
    const step = cloudLogin(forge, spec).steps[0]!;
    const out = await run("bash", ["-e", "-c", step.run.join("\n")], { env: { PATH: process.env.PATH!, GITHUB_ENV: githubEnv, RUNNER_TEMP: dir, ...env } }).catch((e: { stderr: string; code: number }) => ({ stderr: e.stderr, failed: e.code }));
    return { dir, vars: parseEnvFile(readFileSync(githubEnv, "utf-8")), out };
  }

  test.each(["github", "forgejo"] as const)("%s: every cloud's token in a file, and the variables its tools read", async (forge) => {
    const before = emu.log.minted.length;
    const { dir, vars, out } = await actionsStep(forge, SPEC);
    expect(out).not.toHaveProperty("failed");
    expect(emu.log.minted.slice(before)).toEqual([AUD.aws, AUD.gcp, AUD.azure]);
    // AWS: the SDKs' web identity provider.
    expect(vars).toMatchObject({ AWS_ROLE_ARN: SPEC.aws!.role, AWS_ROLE_SESSION_NAME: "terragucci-plan", AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "eu-west-1" });
    expect(vars.AWS_WEB_IDENTITY_TOKEN_FILE!.startsWith(`${dir}/chant-oidc-aws-`)).toBe(true);
    expect(readFileSync(vars.AWS_WEB_IDENTITY_TOKEN_FILE!, "utf-8")).toBe(`${EMULATED_JWT_PREFIX}.${Buffer.from(AUD.aws).toString("base64url")}.${before + 1}`);
    expect(statSync(vars.AWS_WEB_IDENTITY_TOKEN_FILE!).mode & 0o777).toBe(0o600);
    // GCP: an external_account file over the GCP token, for the libraries and gcloud.
    expect(vars.CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE).toBe(vars.GOOGLE_APPLICATION_CREDENTIALS);
    const cred = JSON.parse(readFileSync(vars.GOOGLE_APPLICATION_CREDENTIALS!, "utf-8"));
    expect(cred).toEqual({
      type: "external_account",
      audience: `//iam.googleapis.com/${PROVIDER}`,
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      token_url: "https://sts.googleapis.com/v1/token",
      service_account_impersonation_url: "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/plan@proj.iam.gserviceaccount.com:generateAccessToken",
      credential_source: { file: expect.stringContaining(`${dir}/chant-oidc-gcp-`) },
    });
    expect(readFileSync(cred.credential_source.file, "utf-8")).toContain(Buffer.from(AUD.gcp).toString("base64url"));
    // Azure: the SDKs' workload identity and azurerm's OIDC, over one file.
    expect(vars).toMatchObject({
      AZURE_CLIENT_ID: SPEC.azure!.clientId,
      AZURE_TENANT_ID: TENANT,
      ARM_USE_OIDC: "true",
      ARM_CLIENT_ID: SPEC.azure!.clientId,
      ARM_TENANT_ID: TENANT,
      AZURE_SUBSCRIPTION_ID: SPEC.azure!.subscriptionId,
      ARM_SUBSCRIPTION_ID: SPEC.azure!.subscriptionId,
    });
    expect(vars.ARM_OIDC_TOKEN_FILE_PATH).toBe(vars.AZURE_FEDERATED_TOKEN_FILE);
    expect(readFileSync(vars.ARM_OIDC_TOKEN_FILE_PATH!, "utf-8")).toContain(Buffer.from(AUD.azure).toString("base64url"));
    // Nothing a token: the variables name files.
    for (const v of Object.values(vars)) expect(v).not.toContain(EMULATED_JWT_PREFIX);
  });

  test("an emulator's endpoints reach the variables and the credential file", async () => {
    const { vars } = await actionsStep("github", { aws: { ...SPEC.aws!, endpoint: `${emu.url}/aws/` }, gcp: { ...SPEC.gcp!, stsEndpoint: `${emu.url}/gsts/`, iamEndpoint: `${emu.url}/giam` }, azure: { ...SPEC.azure!, authority: `${emu.url}/entra/` } });
    expect(vars.AWS_ENDPOINT_URL_STS).toBe(`${emu.url}/aws`);
    expect(vars.AZURE_AUTHORITY_HOST).toBe(`${emu.url}/entra`);
    const cred = JSON.parse(readFileSync(vars.GOOGLE_APPLICATION_CREDENTIALS!, "utf-8"));
    expect(cred.token_url).toBe(`${emu.url}/gsts/v1/token`);
    expect(cred.service_account_impersonation_url).toBe(`${emu.url}/giam/v1/projects/-/serviceAccounts/plan@proj.iam.gserviceaccount.com:generateAccessToken`);
  });

  test.each([
    ["github", /the job can request no OIDC token for aws: it needs permissions: id-token: write/],
    ["forgejo", /Forgejo serves one from version 15, with Forgejo Runner 12.5 or later, to a job with enable-openid-connect: true/],
  ] as const)("%s: a job served no token stops, saying what it needs", async (forge, said) => {
    const { vars, out } = await actionsStep(forge, { aws: SPEC.aws }, {});
    expect(out).toMatchObject({ failed: 1, stderr: expect.stringMatching(said) });
    expect(vars).toEqual({});
  });

  test("forgejo: a runner's token file is used where it is, and no token is requested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-login-runner-"));
    writeFileSync(join(dir, "token"), "eyJrunner.token.1\n");
    const before = emu.log.minted.length;
    const { vars, out } = await actionsStep("forgejo", { aws: { ...SPEC.aws!, tokenFile: "$RUNNER_TOKENS/token" }, azure: { ...SPEC.azure!, tokenFile: "${RUNNER_TOKENS}/token" } }, { RUNNER_TOKENS: dir });
    expect(out).not.toHaveProperty("failed");
    expect(emu.log.minted.length).toBe(before);
    expect(vars.AWS_WEB_IDENTITY_TOKEN_FILE).toBe(join(dir, "token"));
    expect(vars.ARM_OIDC_TOKEN_FILE_PATH).toBe(join(dir, "token"));
    const missing = await actionsStep("forgejo", { aws: { ...SPEC.aws!, tokenFile: "$RUNNER_TOKENS/none" } }, { RUNNER_TOKENS: dir });
    expect(missing.out).toMatchObject({ failed: 1, stderr: expect.stringContaining(`aws's tokenFile ${dir}/none cannot be read`) });
  });

  test("gitlab: the id_tokens tokens go to files, the variables are sourced, and the tokens and spec are unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-login-gl-"));
    const { steps, idTokens } = gitlabCloudLogin(SPEC);
    const tokens = Object.fromEntries(Object.keys(idTokens).map((k) => [k, `eyJgitlab.${k}.1`]));
    // GitLab runs the script's lines in one shell that stops at the first failure.
    const script = [...steps[0]!.run, "env"].join("\n");
    const { stdout } = await run("sh", ["-e", "-c", script], { env: { PATH: process.env.PATH!, TMPDIR: dir, CI_JOB_ID: "77", ...tokens } });
    const env = parseEnvFile(stdout);
    for (const k of [...Object.keys(idTokens), LOGIN_SPEC_ENV, "CHANT_CLOUD_LOGIN_VARS"]) expect(env[k]).toBeUndefined();
    expect(readFileSync(env.AWS_WEB_IDENTITY_TOKEN_FILE!, "utf-8")).toBe("eyJgitlab.CHANT_ID_TOKEN_AWS.1");
    expect(readFileSync(env.AZURE_FEDERATED_TOKEN_FILE!, "utf-8")).toBe("eyJgitlab.CHANT_ID_TOKEN_AZURE.1");
    expect(readFileSync(JSON.parse(readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS!, "utf-8")).credential_source.file, "utf-8")).toBe("eyJgitlab.CHANT_ID_TOKEN_GCP.1");
    expect(env).toMatchObject({ AWS_ROLE_ARN: SPEC.aws!.role, ARM_CLIENT_ID: SPEC.azure!.clientId });
    // The variables were never written to a file: the directory holds the token files and the credential file alone.
    expect(readdirSync(dir).every((f) => /^chant-(oidc|gcp)-/.test(f))).toBe(true);
  });

  test("gitlab: a job without the cloud's id_tokens stops, naming the entry it needs", async () => {
    const step = gitlabCloudLogin({ gcp: SPEC.gcp }).steps[0]!;
    const failed = await run("sh", ["-e", "-c", step.run.join("\n")], { env: { PATH: process.env.PATH!, TMPDIR: tmpdir(), CI_JOB_ID: "78" } }).catch((e: { stderr: string }) => e);
    expect((failed as { stderr: string }).stderr).toContain(`the job has no CHANT_ID_TOKEN_GCP: it needs id_tokens: CHANT_ID_TOKEN_GCP: aud: ${AUD.gcp}`);
  });

  test("per target: each identity's variables in the targets file, and targetCloudEnv hands each root its own", async () => {
    const spec: CloudLoginSpec = {
      aws: { role: "arn:aws:iam::1:role/default", targets: [{ targets: ["envs/prod/**"], role: "arn:aws:iam::1:role/prod" }], region: "eu-west-1" },
      gcp: { serviceAccount: "default@p.iam.gserviceaccount.com", targets: [{ targets: ["envs/prod/**"], serviceAccount: "prod@p.iam.gserviceaccount.com" }], provider: PROVIDER },
      azure: { tenantId: TENANT, targets: [{ targets: ["envs/prod/**"], clientId: "prod-client" }] },
    };
    const { vars } = await actionsStep("github", spec);
    expect(vars[CLOUD_TARGETS_ENV]).toBeDefined();
    // Static keys in the job's environment would win over the role, so a root with another role starts without them.
    const job = { ...vars, AWS_ACCESS_KEY_ID: "static" };
    const prod = targetCloudEnv(job, "envs/prod/net");
    expect(prod.AWS_ROLE_ARN).toBe("arn:aws:iam::1:role/prod");
    expect(prod.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(prod.AWS_WEB_IDENTITY_TOKEN_FILE).toBe(vars.AWS_WEB_IDENTITY_TOKEN_FILE);
    expect(JSON.parse(readFileSync(prod.GOOGLE_APPLICATION_CREDENTIALS!, "utf-8")).service_account_impersonation_url).toContain("/serviceAccounts/prod@p.iam.gserviceaccount.com:");
    expect(prod).toMatchObject({ ARM_CLIENT_ID: "prod-client", AZURE_CLIENT_ID: "prod-client", ARM_OIDC_TOKEN_FILE_PATH: expect.stringContaining("/chant-oidc-azure-") });
    const other = targetCloudEnv(job, "envs/dev/net");
    expect(other.AWS_ROLE_ARN).toBe("arn:aws:iam::1:role/default");
    expect(other.GOOGLE_APPLICATION_CREDENTIALS).toBe(vars.GOOGLE_APPLICATION_CREDENTIALS);
    // Azure has no job identity here, so a root no glob takes holds none.
    expect(other.ARM_CLIENT_ID).toBeUndefined();
  });

  test("azure cli: az logs in as the job's client with the token, and sets the subscription", async () => {
    const bin = mkdtempSync(join(tmpdir(), "chant-login-az-"));
    const calls = join(bin, "calls");
    writeFileSync(join(bin, "az"), `#!/bin/sh\necho "$*" >> "${calls}"\n`);
    chmodSync(join(bin, "az"), 0o755);
    const { out } = await actionsStep("github", { azure: { ...SPEC.azure!, cli: true } }, { ...emu.requestEnv, PATH: `${bin}:${process.env.PATH}` });
    expect(out).not.toHaveProperty("failed");
    const lines = readFileSync(calls, "utf-8").trim().split("\n");
    expect(lines[0]).toMatch(new RegExp(`^login --service-principal --username ${SPEC.azure!.clientId} --tenant ${TENANT} --federated-token ${EMULATED_JWT_PREFIX}\\.\\S+ --allow-no-subscriptions --output none$`));
    expect(lines[1]).toBe(`account set --subscription ${SPEC.azure!.subscriptionId}`);
  });
});

describe("the gaps terragucci's login needs closed (#4930)", () => {
  let emu: OidcEmulator;
  beforeAll(async () => {
    emu = await startOidcEmulator();
  });
  afterAll(async () => {
    await emu.close();
  });

  const parseEnv = (text: string): Record<string, string> => Object.fromEntries(text.trim().split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

  /**
   * Runs a login and then `env` in one shell with -e off, as terragucci's
   * steps run (they read each stage's exit code): the variables the same
   * step sees, and what `$GITHUB_ENV` got.
   */
  async function oneStep(forge: LoginForge, spec: CloudLoginSpec, sameStep: boolean, env: Record<string, string> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "chant-login-4930-"));
    const githubEnv = join(dir, "github-env");
    writeFileSync(githubEnv, "");
    const { steps, idTokens } = cloudLogin(forge, spec, { sameStep });
    const tokens = forge === "gitlab" ? Object.fromEntries(Object.keys(idTokens).map((k) => [k, `eyJgitlab.${k}.1`])) : emu.requestEnv;
    const script = ["set +e", ...steps[0]!.run, "env"].join("\n");
    const r = await run("bash", ["-c", script], { env: { PATH: process.env.PATH!, GITHUB_ENV: githubEnv, RUNNER_TEMP: dir, TMPDIR: dir, ...tokens, ...env } }).catch((e: { stdout: string; stderr: string; code: number }) => ({ stdout: e.stdout, stderr: e.stderr, failed: e.code }));
    return { dir, step: parseEnv(r.stdout), githubEnv: parseEnv(readFileSync(githubEnv, "utf-8")), run: r };
  }

  test.each(FORGES)("%s: a spec with no region leaves the job's region, and one that names it sets it as before", async (forge) => {
    const none = await oneStep(forge, { aws: { role: "arn:aws:iam::1:role/p" } }, true, { AWS_REGION: "ap-south-1", AWS_DEFAULT_REGION: "ap-south-1" });
    expect(none.step).toMatchObject({ AWS_ROLE_ARN: "arn:aws:iam::1:role/p", AWS_REGION: "ap-south-1", AWS_DEFAULT_REGION: "ap-south-1" });
    const unset = await oneStep(forge, { aws: { role: "arn:aws:iam::1:role/p" } }, true);
    expect(unset.step.AWS_REGION).toBeUndefined();
    expect(unset.step.AWS_DEFAULT_REGION).toBeUndefined();
    expect(cloudLoginSpec({ aws: { role: "r" } })).toEqual({ aws: { role: "r", audience: "sts.amazonaws.com" } });
    const named = await oneStep(forge, SPEC, true);
    expect(named.step).toMatchObject({ AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "eu-west-1" });
  });

  test("a spec that names a region renders as before: the same spec, in the same order", () => {
    expect(cloudLoginSpec(SPEC).aws).toEqual({ role: SPEC.aws!.role, region: "eu-west-1", sessionName: "terragucci-plan", audience: "sts.amazonaws.com" });
    expect(Object.keys(cloudLoginSpec(SPEC).aws!)).toEqual(["role", "region", "sessionName", "audience"]);
    expect(Object.keys(cloudLoginSpec({ aws: { region: "eu-west-1", role: "r" } }).aws!)).toEqual(["region", "role", "audience"]);
    for (const forge of FORGES) expect(cloudLogin(forge, SPEC, { sameStep: false })).toEqual(cloudLogin(forge, SPEC));
  });

  test.each(["github", "forgejo"] as const)("%s: sameStep exports into the step that runs the login, and leaves $GITHUB_ENV alone", async (forge) => {
    const { step, githubEnv, run: r } = await oneStep(forge, SPEC, true);
    expect(r).not.toHaveProperty("failed");
    expect(githubEnv).toEqual({});
    expect(step).toMatchObject({ AWS_ROLE_ARN: SPEC.aws!.role, ARM_CLIENT_ID: SPEC.azure!.clientId });
    expect(readFileSync(step.AWS_WEB_IDENTITY_TOKEN_FILE!, "utf-8")).toContain(Buffer.from(AUD.aws).toString("base64url"));
    expect(JSON.parse(readFileSync(step.GOOGLE_APPLICATION_CREDENTIALS!, "utf-8")).type).toBe("external_account");
    for (const k of [LOGIN_SPEC_ENV, GITLAB_LOGIN_VARS]) expect(step[k]).toBeUndefined();
    // Without it, the step itself sees nothing: the variables are for later steps.
    const later = await oneStep(forge, SPEC, false);
    expect(later.step.AWS_ROLE_ARN).toBeUndefined();
    expect(later.githubEnv.AWS_ROLE_ARN).toBe(SPEC.aws!.role);
  });

  test("gitlab: sameStep is the script's own lines, as before, and the id_tokens variables are unset", async () => {
    const { step, run: r } = await oneStep("gitlab", SPEC, true);
    expect(r).not.toHaveProperty("failed");
    expect(step).toMatchObject({ AWS_ROLE_ARN: SPEC.aws!.role });
    expect(readFileSync(step.AWS_WEB_IDENTITY_TOKEN_FILE!, "utf-8")).toBe("eyJgitlab.CHANT_ID_TOKEN_AWS.1");
    for (const k of ["CHANT_ID_TOKEN_AWS", "CHANT_ID_TOKEN_GCP", "CHANT_ID_TOKEN_AZURE", LOGIN_SPEC_ENV]) expect(step[k]).toBeUndefined();
  });

  test.each(FORGES)("%s: sameStep stops the step on a failed login even with -e off, before the next line", async (forge) => {
    const { run: r, step } = await oneStep(forge, { aws: { role: "r", tokenFile: "$NOWHERE/token" } }, true, { NOWHERE: "/nonexistent-4930" });
    expect(r).toMatchObject({ failed: 1, stderr: expect.stringContaining("aws's tokenFile /nonexistent-4930/token cannot be read") });
    expect(step).toEqual({});
  });

  test.each(FORGES)("%s: an AWS spec with no role points the job at the token file alone, as a Terragrunt credentials job takes it", async (forge) => {
    const dir = mkdtempSync(join(tmpdir(), "chant-login-4930-tok-"));
    writeFileSync(join(dir, "aws"), "eyJstaged.token.1\n");
    expect(cloudLogin(forge, { aws: { tokenFile: "$STAGED/aws" } }).idTokens).toEqual({});
    const staged = await oneStep(forge, { aws: { tokenFile: "$STAGED/aws", sessionName: "terragucci-plan" } }, true, { STAGED: dir });
    expect(staged.run).not.toHaveProperty("failed");
    expect(staged.step).toMatchObject({ AWS_WEB_IDENTITY_TOKEN_FILE: join(dir, "aws"), AWS_ROLE_SESSION_NAME: "terragucci-plan" });
    expect(staged.step.AWS_ROLE_ARN).toBeUndefined();
    // With no tokenFile the job requests the token, as for a role.
    expect(cloudLogin(forge, { aws: {} }).idTokens).toEqual({ CHANT_ID_TOKEN_AWS: AUD.aws });
    const requested = await oneStep(forge, { aws: {} }, true);
    expect(readFileSync(requested.step.AWS_WEB_IDENTITY_TOKEN_FILE!, "utf-8")).toMatch(forge === "gitlab" ? /^eyJgitlab\.CHANT_ID_TOKEN_AWS\.1$/ : new RegExp(Buffer.from(AUD.aws).toString("base64url")));
    expect(requested.step.AWS_ROLE_SESSION_NAME).toBe("chant");
    // GCP and Azure still need an identity: their files and variables name one.
    expect(() => cloudLogin(forge, { gcp: { provider: PROVIDER } })).toThrow(/names no identity/);
  });

  test("an AWS spec with roles by target and none of its own: each target's role, and the token file for the rest", async () => {
    const { step } = await oneStep("github", { aws: { targets: [{ targets: ["envs/prod/**"], role: "arn:aws:iam::1:role/prod" }] } }, true, { AWS_REGION: "ap-south-1" });
    expect(step.AWS_ROLE_ARN).toBeUndefined();
    expect(step.AWS_WEB_IDENTITY_TOKEN_FILE).toBeDefined();
    const prod = targetCloudEnv(step, "envs/prod/net");
    expect(prod).toMatchObject({ AWS_ROLE_ARN: "arn:aws:iam::1:role/prod", AWS_WEB_IDENTITY_TOKEN_FILE: step.AWS_WEB_IDENTITY_TOKEN_FILE, AWS_REGION: "ap-south-1" });
    expect(targetCloudEnv(step, "envs/dev/net").AWS_ROLE_ARN).toBeUndefined();
  });

  test.each(FORGES)("%s: a login's targets file is no trade's: CHANT_CLOUD_TRADED stays unset", async (forge) => {
    const spec: CloudLoginSpec = { aws: { role: "arn:aws:iam::1:role/default", targets: [{ targets: ["envs/prod/**"], role: "arn:aws:iam::1:role/prod" }] } };
    const { step } = await oneStep(forge, spec, true);
    expect(step[CLOUD_TARGETS_ENV]).toBeDefined();
    expect(step[CLOUD_TRADED_ENV]).toBeUndefined();
    expect(cloudsTraded(step)).toEqual([]);
  });

  test("the trade says it traded, with or without targets, so its targets file is told from a login's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-trade-4930-"));
    const trade = async (spec: CloudTradeSpec): Promise<Record<string, string>> => {
      const file = join(dir, `github-env-${Math.random().toString(16).slice(2)}`);
      writeFileSync(file, "");
      await run("sh", ["-c", tradeLine(file, "github-env")], { env: { PATH: process.env.PATH!, ...emu.requestEnv, RUNNER_TEMP: dir, [TRADE_SPEC_ENV]: JSON.stringify(emu.pointAt(spec)) } });
      return parseEnv(readFileSync(file, "utf-8"));
    };
    const aws = { role: "arn:aws:iam::1:role/default", region: "eu-west-1", audience: "sts.amazonaws.com" };
    const targeted = await trade({ aws: { ...aws, targets: [{ targets: ["envs/prod/**"], role: "arn:aws:iam::1:role/prod" }] }, gcp: { serviceAccount: "plan@p.iam.gserviceaccount.com", provider: PROVIDER, audience: AUD.gcp } });
    expect(targeted[CLOUD_TARGETS_ENV]).toBeDefined();
    expect(targeted[CLOUD_TRADED_ENV]).toBe("aws,gcp");
    expect(cloudsTraded(targeted)).toEqual(["aws", "gcp"]);
    // A trade's identity sets its own region, so a target still gets it.
    expect(targetCloudEnv({ ...targeted, AWS_REGION: "ap-south-1" }, "envs/prod/net").AWS_REGION).toBe("eu-west-1");
    const plain = await trade({ aws });
    expect(plain[CLOUD_TARGETS_ENV]).toBeUndefined();
    expect(plain[CLOUD_TRADED_ENV]).toBe("aws");
  });
});
