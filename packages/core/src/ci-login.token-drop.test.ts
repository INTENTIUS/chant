/**
 * #4912: after the cloud login, the rest of the job reaches neither the
 * forge's token request nor the token file unless it needs them, and
 * GitLab's trade writes no file of variables. The tests run the rendered
 * lines as a runner runs a step: GitHub and Forgejo run the step's script
 * as a file (`bash --noprofile --norc -eo pipefail <file>`), GitLab runs the
 * job's script in one shell. Each runs against the local emulator of the
 * forge's token URL and the clouds (./__fixtures__/oidc-emulator.ts). Test
 * values only; no cloud is reached.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cloudLogin, LOGIN_CLEAR_TOKENS, LOGIN_TOKEN_FILES_ENV, type CloudLoginSpec, type LoginForge } from "./ci-login";
import { GITLAB_TRADE_VARS, gitlabTradeLines, idTokenVar, OIDC_REQUEST_VARS, TRADE_SPEC_ENV, type CloudTradeSpec } from "./ci-identity";
import { emulatedCredentials, EMULATED_JWT_PREFIX, startOidcEmulator, type OidcEmulator } from "./__fixtures__/oidc-emulator";

const run = promisify(execFile);

const PROVIDER = "projects/123/locations/global/workloadIdentityPools/ci/providers/forge";
const TENANT = "00000000-0000-0000-0000-000000000001";
const SPEC: CloudLoginSpec = {
  aws: { role: "arn:aws:iam::111111111111:role/plan", region: "eu-west-1" },
  gcp: { serviceAccount: "plan@proj.iam.gserviceaccount.com", provider: PROVIDER },
  azure: { clientId: "11111111-1111-1111-1111-111111111111", tenantId: TENANT },
};
const FORGES: LoginForge[] = ["github", "gitlab", "forgejo"];
const FORGE_SECRET = "forge-secret-4912";

/** A child of the step that asks the forge for a token, as the change's code could: it prints what it got. */
const ASK = `node -e 'const u=process.env.ACTIONS_ID_TOKEN_REQUEST_URL,k=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;if(!u||!k){console.log("request:none");process.exit(0)}fetch(u+"&audience=x",{headers:{authorization:"bearer "+k}}).then(r=>r.text()).then(t=>console.log("request:"+t))'`;

const parseEnv = (text: string): Record<string, string> => Object.fromEntries(text.trim().split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

let emu: OidcEmulator;
beforeAll(async () => {
  emu = await startOidcEmulator();
});
afterAll(async () => {
  await emu.close();
});

/**
 * Runs the login with `restart` and then `rest` as one step of `forge`,
 * with a forge token and the job's token request (GitLab: its id_tokens) in
 * the step's environment.
 */
async function loginStep(forge: LoginForge, spec: CloudLoginSpec, rest: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "chant-login-4912-"));
  const runnerTemp = mkdtempSync(join(dir, "runner-"));
  const scripts = mkdtempSync(join(dir, "scripts-"));
  const githubEnv = join(scripts, "github-env");
  writeFileSync(githubEnv, "");
  const { steps, idTokens } = cloudLogin(forge, spec, { restart: { also: ["CHANT_FORGE_TOKEN"] } });
  const file = join(scripts, "step.sh");
  writeFileSync(file, [...steps[0]!.run, ...rest].join("\n") + "\n");
  const tokens = forge === "gitlab" ? Object.fromEntries(Object.keys(idTokens).map((k) => [k, `${EMULATED_JWT_PREFIX}.${k}.gitlab`])) : emu.requestEnv;
  const env = { PATH: process.env.PATH!, GITHUB_ENV: githubEnv, RUNNER_TEMP: runnerTemp, TMPDIR: runnerTemp, CHANT_FORGE_TOKEN: FORGE_SECRET, SCRATCH: scripts, ...tokens };
  const args = forge === "gitlab" ? ["-e", file] : ["--noprofile", "--norc", "-eo", "pipefail", file];
  const r = await run(forge === "gitlab" ? "sh" : "bash", args, { env }).catch((e: { stdout: string; stderr: string; code: number }) => ({ stdout: e.stdout, stderr: e.stderr, failed: e.code }));
  return { r, scripts, runnerTemp, githubEnv };
}

describe("the login, then the step without the token request (#4912)", () => {
  test.each(FORGES)("%s: the tool reads its token file; the step's children reach no token request, forge token or id token; the token file is empty once the step ends", async (forge) => {
    const before = emu.log.minted.length;
    const { r, scripts } = await loginStep(forge, SPEC, [
      'env > "$SCRATCH/seen"',
      `${ASK} >> "$SCRATCH/seen"`,
      // The cloud's tool reads the token file while the step runs.
      'cat "$AWS_WEB_IDENTITY_TOKEN_FILE" > "$SCRATCH/during"',
      'printf "%s" "$AWS_WEB_IDENTITY_TOKEN_FILE" > "$SCRATCH/aws-file"',
    ]);
    expect(r).not.toHaveProperty("failed");
    const seen = readFileSync(join(scripts, "seen"), "utf-8");
    const env = parseEnv(seen);
    expect(env).toMatchObject({ AWS_ROLE_ARN: SPEC.aws!.role, ARM_CLIENT_ID: SPEC.azure!.clientId });
    expect(seen).toContain("request:none");
    expect(seen).not.toContain(FORGE_SECRET);
    for (const v of OIDC_REQUEST_VARS) expect(env[v], v).toBeUndefined();
    // The login ran once: a restarted step skips it.
    expect(emu.log.minted.length - before).toBe(forge === "gitlab" ? 0 : 3);
    expect(r.stderr.split(`logged in from the OIDC token file as ${SPEC.aws!.role}`).length - 1).toBe(1);
    expect(readFileSync(join(scripts, "during"), "utf-8")).toContain(EMULATED_JWT_PREFIX);
    // Once the step is done, a later step finds the login's token files empty.
    const files = env[LOGIN_TOKEN_FILES_ENV]!.split(":");
    expect(files).toHaveLength(3);
    expect(files).toContain(readFileSync(join(scripts, "aws-file"), "utf-8"));
    for (const f of files) expect(readFileSync(f, "utf-8"), f).toBe("");
  });

  test.each(["github", "forgejo"] as const)("%s: a step whose script is no file keeps running, with the request variables unset", async (forge) => {
    const { steps } = cloudLogin(forge, { aws: SPEC.aws }, { restart: true });
    const dir = mkdtempSync(join(tmpdir(), "chant-login-4912-c-"));
    const r = await run("bash", ["-e", "-c", [...steps[0]!.run, "env", ASK].join("\n")], { env: { PATH: process.env.PATH!, RUNNER_TEMP: dir, ...emu.requestEnv } });
    const env = parseEnv(r.stdout);
    expect(env.AWS_ROLE_ARN).toBe(SPEC.aws!.role);
    expect(r.stdout).toContain("request:none");
    expect(env.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
  });

  test("a runner's own token file is never emptied, and is not listed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-login-4912-runner-"));
    writeFileSync(join(dir, "token"), "eyJrunner.token.1\n");
    const { steps } = cloudLogin("forgejo", { aws: { ...SPEC.aws!, tokenFile: `${dir}/token` }, azure: SPEC.azure }, { restart: true });
    const scripts = mkdtempSync(join(tmpdir(), "chant-login-4912-rs-"));
    const file = join(scripts, "step.sh");
    writeFileSync(file, [...steps[0]!.run, `env > "${scripts}/seen"`].join("\n") + "\n");
    await run("bash", ["--noprofile", "--norc", "-eo", "pipefail", file], { env: { PATH: process.env.PATH!, RUNNER_TEMP: scripts, ...emu.requestEnv } });
    const env = parseEnv(readFileSync(join(scripts, "seen"), "utf-8"));
    expect(env[LOGIN_TOKEN_FILES_ENV]!.split(":")).toEqual([env.AZURE_FEDERATED_TOKEN_FILE]);
    expect(readFileSync(join(dir, "token"), "utf-8")).toBe("eyJrunner.token.1\n");
    expect(readFileSync(env.AZURE_FEDERATED_TOKEN_FILE!, "utf-8")).toBe("");
  });

  test.each(["github", "forgejo"] as const)("%s: a login in a step of its own lists its token files for later steps, and LOGIN_CLEAR_TOKENS empties them", async (forge) => {
    const dir = mkdtempSync(join(tmpdir(), "chant-login-4912-sep-"));
    const githubEnv = join(dir, "github-env");
    writeFileSync(githubEnv, "");
    const { steps } = cloudLogin(forge, SPEC);
    await run("bash", ["-e", "-c", steps[0]!.run.join("\n")], { env: { PATH: process.env.PATH!, GITHUB_ENV: githubEnv, RUNNER_TEMP: dir, ...emu.requestEnv } });
    const vars = parseEnv(readFileSync(githubEnv, "utf-8"));
    const files = vars[LOGIN_TOKEN_FILES_ENV]!.split(":");
    expect(files.sort()).toEqual([vars.AWS_WEB_IDENTITY_TOKEN_FILE, vars.AZURE_FEDERATED_TOKEN_FILE, JSON.parse(readFileSync(vars.GOOGLE_APPLICATION_CREDENTIALS!, "utf-8")).credential_source.file].sort());
    for (const f of files) expect(readFileSync(f, "utf-8")).toContain(EMULATED_JWT_PREFIX);
    // The job's last step, after the tool.
    await run("bash", ["-e", "-c", LOGIN_CLEAR_TOKENS], { env: { PATH: process.env.PATH!, ...vars } });
    for (const f of files) expect(readFileSync(f, "utf-8")).toBe("");
  });

  test("the restart is rendered as one block at the top of the step, and GitLab, whose script is no file, unsets instead", () => {
    const github = cloudLogin("github", SPEC, { restart: { also: ["CHANT_FORGE_TOKEN"] } }).steps[0]!.run;
    expect(github[0]).toBe('if [ -z "${CHANT_CLOUD_LOGGED_IN:-}" ]; then');
    expect(github.find((l) => l.startsWith("if [ -z \"${CHANT_CLOUD_LOGGED_IN:-}\" ] && "))).toContain("exec env -u ACTIONS_ID_TOKEN_REQUEST_URL -u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u CHANT_FORGE_TOKEN CHANT_CLOUD_LOGGED_IN=1 bash");
    expect(cloudLogin("forgejo", SPEC, { restart: { shell: "sh" } }).steps[0]!.run.join("\n")).toContain('CHANT_CLOUD_LOGGED_IN=1 sh -e "$0"');
    const gitlab = cloudLogin("gitlab", SPEC, { restart: { also: ["CHANT_FORGE_TOKEN"] } }).steps[0]!.run;
    expect(gitlab.join("\n")).not.toContain("exec env");
    expect(gitlab).toContain("unset CHANT_FORGE_TOKEN");
    // restart takes the step's form: sameStep is implied.
    for (const forge of FORGES) expect(cloudLogin(forge, SPEC, { restart: true }).steps[0]!.run.join("\n")).not.toContain("$GITHUB_ENV");
  });
});

describe("GitLab's trade writes no file (#4912)", () => {
  test("the trade's exports are captured and evaluated, the token variables unset, and no file is written", async () => {
    const lines = gitlabTradeLines(["CHANT_FORGE_TOKEN"]);
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toMatch(/\brm\b/);
    expect(lines[0]).toMatch(new RegExp(`^${GITLAB_TRADE_VARS}="\\$\\(cd / && node -e '.*' "-" sh\\)"$`));
    const tmp = mkdtempSync(join(tmpdir(), "chant-trade-4912-tmp-"));
    const scripts = mkdtempSync(join(tmpdir(), "chant-trade-4912-"));
    const file = join(scripts, "job.sh");
    writeFileSync(file, [...lines, "env"].join("\n"));
    const spec: CloudTradeSpec = emu.pointAt({ aws: { role: "arn:aws:iam::111111111111:role/plan", region: "eu-west-1", audience: "sts.amazonaws.com" } });
    const r = await run("sh", ["-e", file], { env: { PATH: process.env.PATH!, TMPDIR: tmp, CI_JOB_ID: "4912", CHANT_FORGE_TOKEN: FORGE_SECRET, [idTokenVar("aws")]: `${EMULATED_JWT_PREFIX}.aws.gitlab`, [TRADE_SPEC_ENV]: JSON.stringify(spec) } });
    const env = parseEnv(r.stdout);
    expect(env.AWS_ACCESS_KEY_ID).toBe(emulatedCredentials("arn:aws:iam::111111111111:role/plan").accessKeyId);
    for (const v of [...OIDC_REQUEST_VARS, GITLAB_TRADE_VARS, "CHANT_FORGE_TOKEN"]) expect(env[v], v).toBeUndefined();
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("a failed trade stops the script", async () => {
    const scripts = mkdtempSync(join(tmpdir(), "chant-trade-4912-f-"));
    const file = join(scripts, "job.sh");
    writeFileSync(file, [...gitlabTradeLines(), "echo went-on"].join("\n"));
    const r = await run("sh", ["-e", file], { env: { PATH: process.env.PATH!, CI_JOB_ID: "4912", [TRADE_SPEC_ENV]: JSON.stringify({ aws: { role: "r", region: "eu-west-1", audience: "a" } }) } }).catch((e: { stdout: string; code: number }) => e);
    expect(r).toMatchObject({ code: 1 });
    expect((r as { stdout: string }).stdout).not.toContain("went-on");
  });
});

describe("GCP's stsEndpoint takes a full token URL too (#4912)", () => {
  test("the login writes it as the credential file's token_url, and the base form still gains /v1/token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-login-4912-gcp-"));
    for (const [sts, url] of [
      ["https://sts.us-east1.rep.googleapis.com/v1/token", "https://sts.us-east1.rep.googleapis.com/v1/token"],
      ["https://sts.googleapis.com/", "https://sts.googleapis.com/v1/token"],
    ] as const) {
      const githubEnv = join(dir, `env-${Math.random().toString(16).slice(2)}`);
      writeFileSync(githubEnv, "");
      const { steps } = cloudLogin("github", { gcp: { ...SPEC.gcp!, stsEndpoint: sts } });
      await run("bash", ["-e", "-c", steps[0]!.run.join("\n")], { env: { PATH: process.env.PATH!, GITHUB_ENV: githubEnv, RUNNER_TEMP: dir, ...emu.requestEnv } });
      const vars = parseEnv(readFileSync(githubEnv, "utf-8"));
      expect(JSON.parse(readFileSync(vars.GOOGLE_APPLICATION_CREDENTIALS!, "utf-8")).token_url).toBe(url);
    }
  });

  test("the trade posts to a full token URL as given", async () => {
    const lines = gitlabTradeLines();
    const scripts = mkdtempSync(join(tmpdir(), "chant-trade-4912-gcp-"));
    const file = join(scripts, "job.sh");
    writeFileSync(file, [...lines, "env"].join("\n"));
    const pointed = emu.pointAt({ gcp: { serviceAccount: "plan@proj.iam.gserviceaccount.com", provider: PROVIDER, audience: `https://iam.googleapis.com/${PROVIDER}` } });
    const spec = { gcp: { ...pointed.gcp!, stsEndpoint: `${pointed.gcp!.stsEndpoint}/v1/token` } };
    const before = emu.log.impersonated.length;
    const r = await run("sh", ["-e", file], { env: { PATH: process.env.PATH!, CI_JOB_ID: "4912", [idTokenVar("gcp")]: `${EMULATED_JWT_PREFIX}.gcp.gitlab`, [TRADE_SPEC_ENV]: JSON.stringify(spec) } });
    expect(parseEnv(r.stdout).GOOGLE_OAUTH_ACCESS_TOKEN).toMatch(/^ya29\./);
    expect(emu.log.impersonated.slice(before)).toEqual(["plan@proj.iam.gserviceaccount.com"]);
  });
});
