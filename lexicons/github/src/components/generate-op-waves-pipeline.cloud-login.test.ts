/**
 * #4788: chant's cloud login (@intentius/chant/ci-login) passed to the Op
 * waves generator as a wave's `before` steps and `idTokens`, and as the
 * plans job's, per cloud. The rendered step is then run with bash, as a
 * runner runs it, against the local token URL emulator.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { githubCloudLogin, type CloudLoginSpec } from "@intentius/chant/ci-login";
import { startOidcEmulator, type OidcEmulator } from "@intentius/chant/__fixtures__/oidc-emulator";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const run = promisify(execFile);

const PROVIDER = "projects/123/locations/global/workloadIdentityPools/ci/providers/forge";
const CLOUDS: Record<"aws" | "gcp" | "azure", { spec: CloudLoginSpec; reads: string }> = {
  aws: { spec: { aws: { role: "arn:aws:iam::111111111111:role/apply", region: "eu-west-1" } }, reads: "AWS_WEB_IDENTITY_TOKEN_FILE" },
  gcp: { spec: { gcp: { serviceAccount: "apply@proj.iam.gserviceaccount.com", provider: PROVIDER } }, reads: "GOOGLE_APPLICATION_CREDENTIALS" },
  azure: { spec: { azure: { clientId: "11111111-1111-1111-1111-111111111111", tenantId: "00000000-0000-0000-0000-000000000001" } }, reads: "ARM_OIDC_TOKEN_FILE_PATH" },
};

function render(login: ReturnType<typeof githubCloudLogin>) {
  const spec: OpWavesSpec = {
    name: "migrations",
    op: "migrate",
    plan: ["./bin/plan", "{target}", "{plan}"],
    waves: [
      { name: "dev", runs: [{ target: "dev" }], gate: "never", idTokens: login.idTokens },
      { name: "prod", runs: [{ target: "a" }], gate: "on-destructive", approval: "pr-review" },
    ],
  };
  return generateGithubOpWavesPipeline(spec, { specFile: "waves.json", waveJobs: { dev: { before: login.steps } }, recordPlans: { before: login.steps, idTokens: login.idTokens } }).files;
}

type Step = { name?: string; run?: string };
type Job = { steps: Step[]; permissions?: Record<string, string>; "enable-openid-connect"?: boolean };
const jobsOf = (yaml: string) => (parseYAML(yaml) as { jobs: Record<string, Job> }).jobs;

describe("generateGithubOpWavesPipeline: chant's cloud login (#4788)", () => {
  let emu: OidcEmulator;
  beforeAll(async () => {
    emu = await startOidcEmulator();
  });
  afterAll(async () => {
    await emu.close();
  });

  test.each(Object.keys(CLOUDS) as Array<keyof typeof CLOUDS>)("%s: the wave job and the plans job log in before their command, with an OIDC token, and the step runs", async (cloud) => {
    const login = githubCloudLogin(CLOUDS[cloud].spec);
    const files = render(login);
    const wave = jobsOf(files[0]!.yaml)["wave-1-dev"]!;
    const plans = jobsOf(files.find((f) => f.name === "migrations-plans.yml")!.yaml)["record-plans"]!;
    for (const [job, next] of [[wave, "chant run wave --spec waves.json --wave 1"], [plans, "chant run wave --spec waves.json --record-plans"]] as const) {
      const at = job.steps.findIndex((s) => s.name === login.steps[0]!.name);
      expect(at).toBeGreaterThan(0);
      expect(job.steps[at + 1]!.run).toBe(next);
      expect(job.permissions?.["id-token"]).toBe("write");
    }
    // The prod wave logs in to nothing.
    expect(jobsOf(files[0]!.yaml)["wave-2-prod"]!.steps.map((s) => s.name)).not.toContain(login.steps[0]!.name);

    const dir = mkdtempSync(join(tmpdir(), "chant-login-github-"));
    const githubEnv = join(dir, "env");
    writeFileSync(githubEnv, "");
    const step = wave.steps.find((s) => s.name === login.steps[0]!.name)!;
    await run("bash", ["-e", "-c", step.run!], { env: { PATH: process.env.PATH!, GITHUB_ENV: githubEnv, RUNNER_TEMP: dir, ...emu.requestEnv } });
    const vars = Object.fromEntries(readFileSync(githubEnv, "utf-8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    expect(vars[CLOUDS[cloud].reads]!.startsWith(dir)).toBe(true);
    expect(emu.log.minted.at(-1)).toBe(Object.values(login.idTokens)[0]);
  });
});
