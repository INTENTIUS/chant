/**
 * #4296: the pull-request workflow's plan job trades its OIDC token for the
 * plan identity before the change is checked out, and the change's code
 * never holds a token, a way to request one, or the apply identity.
 *
 * The behaviour tests run the generated steps with `sh`, as a forge runner
 * does: the trade step against a local emulator of the token URL and the
 * clouds (@intentius/chant/__fixtures__/oidc-emulator), then each later
 * step with the runner's token request variables still set and what the
 * trade left in GITHUB_ENV, its own commands replaced by a probe that
 * prints what it sees and tries to request a token. Test values only.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { dropForgeTokens, FORGE_TOKEN_VARS } from "@intentius/chant/ci-handover";
import { OIDC_REQUEST_VARS, resolveCloudIdentity, TRADE_SPEC_ENV, tradeIdentities, type PipelineCloudIdentity } from "@intentius/chant/ci-identity";
import { emulatedCredentials, EMULATED_JWT_PREFIX, EMULATED_REQUEST_TOKEN, startOidcEmulator, type OidcEmulator } from "@intentius/chant/__fixtures__/oidc-emulator";
import { generateGithubPipeline } from "./generate-pipeline";

const run = promisify(execFile);

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
  { name: "app", dependsOn: ["net"], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "app" }] }] },
];

const PLAN_ROLE = "arn:aws:iam::111111111111:role/prod-plan";
const APPLY_ROLE = "arn:aws:iam::111111111111:role/prod-apply";
const IDENTITY = resolveCloudIdentity(
  {
    aws: { rules: [{ environments: ["prod"], plan: PLAN_ROLE, apply: APPLY_ROLE }] },
    gcp: { provider: "projects/123/locations/global/workloadIdentityPools/ci/providers/forge", rules: [{ plan: "plan@test.iam.gserviceaccount.com", apply: "apply@test.iam.gserviceaccount.com" }] },
    azure: { tenantId: "test-tenant", rules: [{ plan: "plan-client", apply: "apply-client" }] },
  },
  "prod",
)!;
const APPLY_IDENTITIES = tradeIdentities(IDENTITY.apply);

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  "working-directory"?: string;
}
interface Job {
  permissions?: Record<string, string>;
  steps: Step[];
}

function workflow(identity: PipelineCloudIdentity | undefined, extra: Record<string, unknown> = {}): { jobs: Record<string, Job> } {
  const { yaml } = generateGithubPipeline(ESTATE, {
    env: "prod",
    image: "example/ci:1",
    beforeScript: ["npm ci"],
    extraScript: ["echo after"],
    prLoop: { build: true, applyOnMerge: true, ...(identity ? { identity } : {}), ...extra },
  });
  return parseYAML(yaml) as { jobs: Record<string, Job> };
}

const TRADE_NAME = /^Trade the job's OIDC token for the (plan|apply) identity$/;
const tradeOf = (job: Job): Record<string, unknown> => JSON.parse(job.steps[0]!.env![TRADE_SPEC_ENV]!) as Record<string, unknown>;

describe("the generated jobs' cloud identities (#4296)", () => {
  const doc = workflow(IDENTITY);
  const plan = doc.jobs.plan!;

  test("the plan job's first step trades for the plan identity, before the checkout", () => {
    expect(plan.steps[0]!.name).toMatch(TRADE_NAME);
    expect(plan.steps[0]!.name).toContain("plan identity");
    expect(plan.steps[0]!.uses).toBeUndefined();
    expect(plan.steps[0]!.run).toMatch(/^\(cd \/ && node -e '/);
    expect(plan.steps[1]!.name).toBe("Check out the change");
    expect(tradeOf(plan)).toEqual(IDENTITY.plan);
    expect(plan.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  test("the plan job names no apply identity anywhere", () => {
    const text = JSON.stringify(plan);
    for (const id of APPLY_IDENTITIES) expect(text).not.toContain(id);
  });

  test("every step after the checkout starts by dropping the forge tokens and the OIDC request variables", () => {
    for (const step of plan.steps.slice(2)) expect(step.run!.split("\n")[0]).toBe(dropForgeTokens("sh", OIDC_REQUEST_VARS));
  });

  test("the record job trades for the plan identity and the apply job for the apply identity, each before its checkout", () => {
    const record = doc.jobs.record!;
    const apply = doc.jobs.apply!;
    expect(record.steps[0]!.name).toContain("plan identity");
    expect(tradeOf(record)).toEqual(IDENTITY.plan);
    expect(apply.steps[0]!.name).toContain("apply identity");
    expect(tradeOf(apply)).toEqual(IDENTITY.apply);
    for (const job of [record, apply]) {
      expect(job.steps[1]!.uses).toMatch(/^actions\/checkout@/);
      expect(job.permissions!["id-token"]).toBe("write");
    }
    expect(JSON.stringify(record)).not.toContain(APPLY_ROLE);
  });

  test("with a gate per wave, every wave's apply job trades for the apply identity", () => {
    const waves = workflow(IDENTITY, { waveGate: "prod" }).jobs;
    const names = Object.keys(waves).filter((n) => n.startsWith("apply-wave-"));
    expect(names.length).toBe(2);
    for (const n of names) expect(tradeOf(waves[n]!)).toEqual(IDENTITY.apply);
  });

  test("the plan-note job requests no token and trades nothing", () => {
    const note = doc.jobs["plan-note"]!;
    expect(note.permissions!["id-token"]).toBeUndefined();
    expect(JSON.stringify(note)).not.toContain(TRADE_SPEC_ENV);
  });

  test("without identity no job requests a token, and the plan job is as #4295 left it", () => {
    const plain = workflow(undefined);
    for (const job of Object.values(plain.jobs)) {
      expect(job.permissions?.["id-token"]).toBeUndefined();
      expect(job.steps.some((s) => TRADE_NAME.test(s.name ?? ""))).toBe(false);
    }
    expect(plain.jobs.plan!.steps[1]!.run!.split("\n")[0]).toBe(dropForgeTokens("sh"));
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
const FORGE_SECRET = "ghs_identity_secret_4296";
const TOKENS = Object.fromEntries(FORGE_TOKEN_VARS.map((v) => [v, `${FORGE_SECRET}_${v}`]));

/** Run one step's script as a forge does: a file, `sh -e`. */
async function runStep(script: string, cwd: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  const file = join(cwd, "..", `step-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(file, script);
  try {
    const r = await run("sh", ["-e", file], { cwd, env: { ...BASE, ...env } });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

/** GITHUB_ENV's `NAME=value` lines as the runner applies them to the job's later steps. */
const githubEnv = (text: string): Record<string, string> =>
  Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

/** A probe: what the step's shell and a child see, and whether a request for an apply-audience token succeeds. */
const PROBE = [
  'env > "$SEEN"',
  `sh -c 'env' >> "$SEEN"`,
  `node -e 'const u=process.env.ACTIONS_ID_TOKEN_REQUEST_URL,k=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;if(!u||!k){console.log("no-request-vars");process.exit(0)}fetch(u+"&audience=sts.amazonaws.com",{headers:{authorization:"bearer "+k}}).then(r=>r.text()).then(t=>console.log("minted:"+t))' >> "$SEEN"`,
].join("\n");

describe("the generated plan job, run: the change's code never holds a token or the apply identity (#4296)", () => {
  test("the trade mints and trades for the plan identity alone; every later step sees plan credentials and nothing to request a token with", async () => {
    const identity: PipelineCloudIdentity = { plan: emu.pointAt(IDENTITY.plan), apply: emu.pointAt(IDENTITY.apply) };
    const plan = workflow(identity).jobs.plan!;
    const top = mkdtempSync(join(tmpdir(), "chant-identity-job-"));
    dirs.push(top);
    const work = join(top, "work");
    mkdirSync(work);
    const envFile = join(top, "github-env");
    writeFileSync(envFile, "");
    // The runner gives every step of a job with id-token: write the request variables, and the forge tokens.
    const runner = { ...emu.requestEnv, ...TOKENS, GITHUB_ENV: envFile };
    const before = { minted: emu.log.minted.length, assumed: emu.log.assumed.length, impersonated: emu.log.impersonated.length, clients: emu.log.clients.length };

    const trade = plan.steps[0]!;
    const traded = await runStep(trade.run!, work, { ...runner, ...trade.env });
    expect(traded.stderr).not.toContain("failed");
    expect(traded.code).toBe(0);
    expect(emu.log.minted.length - before.minted).toBe(3);
    expect(emu.log.assumed.slice(before.assumed).map((a) => a.role)).toEqual([PLAN_ROLE]);
    expect(emu.log.impersonated.slice(before.impersonated)).toEqual(["plan@test.iam.gserviceaccount.com"]);
    expect(emu.log.clients.slice(before.clients).map((c) => c.clientId)).toEqual(["plan-client"]);
    const left = githubEnv(readFileSync(envFile, "utf-8"));
    expect(left.AWS_ACCESS_KEY_ID).toBe(emulatedCredentials(PLAN_ROLE).accessKeyId);

    const later = plan.steps.slice(2);
    expect(later.length).toBeGreaterThan(2);
    const mintedAfterTrade = emu.log.minted.length;
    for (const [i, step] of later.entries()) {
      const seen = join(top, `seen-${i}`);
      const lines = step.run!.split("\n");
      const r = await runStep([lines[0], PROBE].join("\n"), work, { ...runner, ...left, ...(step.env ?? {}), SEEN: seen });
      expect(r.code, step.name ?? lines[1]).toBe(0);
      const text = readFileSync(seen, "utf-8");
      expect(text).toContain(`AWS_ACCESS_KEY_ID=${emulatedCredentials(PLAN_ROLE).accessKeyId}`);
      expect(text).toContain("no-request-vars");
      expect(text).not.toContain("minted:");
      expect(text).not.toContain(EMULATED_JWT_PREFIX);
      expect(text).not.toContain(EMULATED_REQUEST_TOKEN);
      expect(text).not.toContain(FORGE_SECRET);
      for (const id of APPLY_IDENTITIES) expect(text).not.toContain(id);
      expect(text).not.toContain(emulatedCredentials(APPLY_ROLE).accessKeyId);
      for (const v of OIDC_REQUEST_VARS) expect(text).not.toMatch(new RegExp(`^${v}=`, "m"));
    }
    // No step after the trade minted a token.
    expect(emu.log.minted.length).toBe(mintedAfterTrade);
    expect(emu.log.assumed.some((a) => a.role === APPLY_ROLE)).toBe(false);
  });
});
