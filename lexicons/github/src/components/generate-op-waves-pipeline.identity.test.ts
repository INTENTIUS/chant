/**
 * #4332: an Op wave's apply split into one job per cloud identity. The
 * deciding job trades its OIDC token for every plan identity of the wave's
 * targets before the checkout, each group's job for its group's apply
 * identities alone, and every later run step starts without the variables
 * a token is requested with. The behaviour test runs the deciding job's
 * trade step and its command step with `sh`, as a runner does, against the
 * local emulator (@intentius/chant/__fixtures__/oidc-emulator), with the
 * command replaced by a probe. Test values only.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { CLOUD_TARGETS_ENV, cloudIdentityWave, OIDC_REQUEST_VARS, resolveCloudIdentity, TRADE_SPEC_ENV, tradeIdentities, type CloudIdentityDeclaration } from "@intentius/chant/ci-identity";
import { emulatedCredentials, EMULATED_JWT_PREFIX, startOidcEmulator, type OidcEmulator } from "@intentius/chant/__fixtures__/oidc-emulator";
import { generateGithubOpWavesPipeline } from "./generate-op-waves-pipeline";

const run = promisify(execFile);
const role = (n: string) => `arn:aws:iam::111111111111:role/${n}`;

const DECL: CloudIdentityDeclaration = {
  aws: {
    rules: [
      { targets: ["envs/prod/**"], plan: role("prod-plan"), apply: role("prod-apply") },
      { targets: ["envs/staging/**"], plan: role("staging-plan"), apply: role("staging-apply") },
      { plan: role("own-plan"), apply: role("own-apply") },
    ],
  },
};
const ROOTS = ["envs/prod/net", "envs/staging/net", "shared/dns"];

function specFor(decl: CloudIdentityDeclaration, roots: string[]): OpWavesSpec {
  return {
    name: "tf-apply",
    op: "tf-apply",
    planWave: ["./bin/plan", "{runs}", "{plans}"],
    applyWave: ["./bin/apply", "{runs}"],
    waves: [{ name: "wave-1", runs: roots.map((target) => ({ target })), ...cloudIdentityWave(decl, "prod", "infra", roots) }],
  };
}

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface Job {
  permissions?: Record<string, string>;
  steps: Step[];
}

const jobsOf = (spec: OpWavesSpec): Record<string, Job> => (parseYAML(generateGithubOpWavesPipeline(spec, { specFile: ".chant/op-waves/tf-apply.spec.json", beforeScript: ["npm ci"] }).files[0]!.yaml) as { jobs: Record<string, Job> }).jobs;
const tradeOf = (job: Job): unknown => JSON.parse(job.steps[0]!.env![TRADE_SPEC_ENV]!);
const UNSET = `unset ${OIDC_REQUEST_VARS.join(" ")}`;

describe("an Op wave's jobs by cloud identity (#4332)", () => {
  const jobs = jobsOf(specFor(DECL, ROOTS));
  const plan = resolveCloudIdentity(DECL, "prod", "infra")!.plan;

  test("one deciding job and a job per identity", () => {
    expect(Object.keys(jobs)).toEqual(["wave-1-wave-1-decide", "wave-1-wave-1-envs-prod", "wave-1-wave-1-envs-staging", "wave-1-wave-1-default"]);
  });

  test("the deciding job trades for every plan identity, before the checkout, and names no apply identity", () => {
    const decide = jobs["wave-1-wave-1-decide"]!;
    expect(decide.steps[0]!.name).toBe("Trade the job's OIDC token for its cloud identities");
    expect(decide.steps[0]!.run).toMatch(/^\(cd \/ && node -e '/);
    expect(decide.steps[1]!.uses).toMatch(/^actions\/checkout@/);
    expect(tradeOf(decide)).toEqual(plan);
    expect(decide.permissions).toEqual({ contents: "write", "id-token": "write" });
    for (const id of [role("prod-apply"), role("staging-apply"), role("own-apply")]) expect(JSON.stringify(decide)).not.toContain(id);
  });

  test("each group's job trades for its own apply identity and holds no other group's", () => {
    const want: Record<string, string> = { "wave-1-wave-1-envs-prod": role("prod-apply"), "wave-1-wave-1-envs-staging": role("staging-apply"), "wave-1-wave-1-default": role("own-apply") };
    for (const [name, id] of Object.entries(want)) {
      const job = jobs[name]!;
      expect(tradeIdentities(tradeOf(job) as never)).toEqual([id]);
      expect(job.steps[1]!.uses).toMatch(/^actions\/checkout@/);
      for (const other of Object.values(want).filter((o) => o !== id)) expect(JSON.stringify(job)).not.toContain(other);
    }
  });

  test("every run step after the trade starts by unsetting the token request variables", () => {
    for (const job of Object.values(jobs)) {
      const runs = job.steps.slice(1).filter((s) => s.run !== undefined);
      expect(runs.length).toBeGreaterThan(0);
      for (const s of runs) expect(s.run!.split("\n")[0]).toBe(UNSET);
    }
  });

  test("a wave with no cloud trades nothing and requests no token", () => {
    const plain = jobsOf(specFor({}, ROOTS));
    expect(Object.keys(plain)).toEqual(["wave-1-wave-1"]);
    for (const job of Object.values(plain)) {
      expect(job.permissions?.["id-token"]).toBeUndefined();
      expect(JSON.stringify(job)).not.toContain(TRADE_SPEC_ENV);
    }
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

describe("the deciding job, run step by step against the emulator (#4332)", () => {
  test("its command step sees the plan identities through the targets file, and cannot request a token", async () => {
    const decide = jobsOf(specFor(DECL, ROOTS))["wave-1-wave-1-decide"]!;
    const temp = mkdtempSync(join(tmpdir(), "chant-op-waves-identity-"));
    dirs.push(temp);
    const githubEnv = join(temp, "github-env");
    writeFileSync(githubEnv, "");
    const base = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", RUNNER_TEMP: temp, ...emu.requestEnv };
    const spec = emu.pointAt(JSON.parse(decide.steps[0]!.env![TRADE_SPEC_ENV]!));
    await run("sh", ["-c", decide.steps[0]!.run!.replace("$GITHUB_ENV", githubEnv)], { env: { ...base, [TRADE_SPEC_ENV]: JSON.stringify(spec) } });
    const traded = Object.fromEntries(readFileSync(githubEnv, "utf-8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    expect(traded.AWS_ACCESS_KEY_ID).toBe(emulatedCredentials(role("own-plan")).accessKeyId);
    const before = emu.log.minted.length;
    // The command step with the command replaced by a probe: what it sees, and a token request.
    const step = decide.steps.find((s) => s.run?.includes("chant run wave"))!;
    const probe = `node -e 'const e=process.env;const f=JSON.parse(require("fs").readFileSync(e.${CLOUD_TARGETS_ENV},"utf8"));console.log("roles:"+Object.keys(f.clouds.aws.vars).join(","));console.log("request:"+(e.ACTIONS_ID_TOKEN_REQUEST_URL&&e.ACTIONS_ID_TOKEN_REQUEST_TOKEN?"yes":"no"))'`;
    const r = await run("sh", ["-e", "-c", `${step.run!.split("\n")[0]}\n${probe}`], { env: { ...base, ...traded } });
    expect(r.stdout).toContain(`roles:${[role("own-plan"), role("prod-plan"), role("staging-plan")].join(",")}`);
    expect(r.stdout).toContain("request:no");
    expect(r.stdout).not.toContain(EMULATED_JWT_PREFIX);
    expect(emu.log.minted.length).toBe(before);
  });
});
