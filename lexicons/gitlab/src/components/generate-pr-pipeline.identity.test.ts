/**
 * #4296: the merge-request pipeline's plan job trades its `id_tokens` for
 * the plan identity before any of the merge request's code runs, then
 * unsets the token variables, so that code never holds a token or the apply
 * identity.
 *
 * The behaviour test runs the plan job's script in one shell, as GitLab
 * does, with the job's id token variables and forge tokens set, against a
 * local emulator of AWS STS (@intentius/chant/__fixtures__/oidc-emulator),
 * and every line after the trade replaced by a probe. Test values only.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { FORGE_TOKEN_VARS, GITLAB_DROP_FORGE_TOKENS } from "@intentius/chant/ci-handover";
import { gitlabTradeLines, idTokenVar, OIDC_REQUEST_VARS, resolveCloudIdentity, TRADE_SPEC_ENV, tradeIdentities, type PipelineCloudIdentity } from "@intentius/chant/ci-identity";
import { emulatedCredentials, EMULATED_JWT_PREFIX, startOidcEmulator, type OidcEmulator } from "@intentius/chant/__fixtures__/oidc-emulator";
import { generateGitlabPipeline } from "./generate-pipeline";

const run = promisify(execFile);

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];

const PLAN_ROLE = "arn:aws:iam::111111111111:role/prod-plan";
const APPLY_ROLE = "arn:aws:iam::111111111111:role/prod-apply";
const IDENTITY = resolveCloudIdentity(
  {
    aws: { rules: [{ plan: PLAN_ROLE, apply: APPLY_ROLE }] },
    azure: { tenantId: "test-tenant", rules: [{ plan: "plan-client", apply: "apply-client" }] },
  },
  "prod",
)!;

interface GitlabJob {
  id_tokens?: Record<string, { aud: string }>;
  variables?: Record<string, string>;
  script: string[];
}

function pipeline(identity: PipelineCloudIdentity | undefined): Record<string, GitlabJob> {
  const { yaml } = generateGitlabPipeline(ESTATE, { env: "prod", image: "example/ci:1", beforeScript: ["npm ci"], prLoop: { applyOnMerge: true, ...(identity ? { identity } : {}) } });
  return parseYAML(yaml) as Record<string, GitlabJob>;
}

describe("the generated GitLab jobs' cloud identities (#4296)", () => {
  const doc = pipeline(IDENTITY);
  const plan = doc.plan!;

  test("the plan job asks for one id token per cloud, and its script trades before anything else, then unsets the tokens", () => {
    expect(plan.id_tokens).toEqual({ [idTokenVar("aws")]: { aud: "sts.amazonaws.com" }, [idTokenVar("azure")]: { aud: "api://AzureADTokenExchange" } });
    expect(plan.script.slice(0, 3)).toEqual(gitlabTradeLines(FORGE_TOKEN_VARS));
    expect(JSON.parse(plan.variables![TRADE_SPEC_ENV]!)).toEqual(IDENTITY.plan);
  });

  test("the plan job names no apply identity", () => {
    const text = JSON.stringify(plan);
    for (const id of tradeIdentities(IDENTITY.apply)) expect(text).not.toContain(id);
  });

  test("the record job takes the plan identity and the apply job the apply identity", () => {
    expect(JSON.parse(doc.record!.variables![TRADE_SPEC_ENV]!)).toEqual(IDENTITY.plan);
    expect(JSON.parse(doc.apply!.variables![TRADE_SPEC_ENV]!)).toEqual(IDENTITY.apply);
    expect(doc.apply!.script.slice(0, 3)).toEqual(gitlabTradeLines());
    expect(doc.apply!.id_tokens).toEqual(plan.id_tokens);
  });

  test("the plan-note job asks for no id token", () => {
    expect(doc["plan-note"]!.id_tokens).toBeUndefined();
  });

  test("without identity the plan script starts as #4295 left it, and no job asks for an id token", () => {
    const plain = pipeline(undefined);
    expect(plain.plan!.script[0]).toBe(GITLAB_DROP_FORGE_TOKENS);
    for (const [name, job] of Object.entries(plain)) if (typeof job === "object" && job && "script" in job) expect((job as GitlabJob).id_tokens, name).toBeUndefined();
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
const FORGE_SECRET = "glpat_identity_secret_4296";

describe("the generated plan script, run: the merge request's code never holds a token or the apply identity (#4296)", () => {
  test("after the trade, the shell and its children see plan credentials and none of the id tokens", async () => {
    const identity: PipelineCloudIdentity = { plan: emu.pointAt(IDENTITY.plan), apply: emu.pointAt(IDENTITY.apply) };
    const plan = pipeline(identity).plan!;
    const dir = mkdtempSync(join(tmpdir(), "chant-identity-gitlab-"));
    dirs.push(dir);
    const seen = join(dir, "seen");
    const jwt = (cloud: string) => `${EMULATED_JWT_PREFIX}.${cloud}.gitlab`;
    // GitLab runs the job's script lines in one shell, with the job's variables and id tokens set.
    const script = [...plan.script.slice(0, 3), `env > "${seen}"`, `sh -c 'env' >> "${seen}"`].join("\n");
    const file = join(dir, "job.sh");
    writeFileSync(file, script);
    const env = {
      ...BASE,
      ...Object.fromEntries(FORGE_TOKEN_VARS.map((v) => [v, `${FORGE_SECRET}_${v}`])),
      ...plan.variables,
      [idTokenVar("aws")]: jwt("aws"),
      [idTokenVar("azure")]: jwt("azure"),
      CI_JOB_ID: "4296",
      TMPDIR: dir,
    };
    const before = emu.log.assumed.length;
    const r = await run("sh", ["-e", file], { cwd: dir, env }).catch((e: { stderr: string }) => {
      throw new Error(e.stderr);
    });
    expect(r.stderr).toContain(`traded the job's OIDC token for ${PLAN_ROLE}`);
    expect(emu.log.assumed.slice(before)).toEqual([{ role: PLAN_ROLE, token: jwt("aws") }]);
    expect(emu.log.clients.at(-1)).toEqual({ clientId: "plan-client", token: jwt("azure") });
    const text = readFileSync(seen, "utf-8");
    expect(text).toContain(`AWS_ACCESS_KEY_ID=${emulatedCredentials(PLAN_ROLE).accessKeyId}`);
    expect(text).toContain("AZURE_CLIENT_ID=plan-client");
    expect(text).not.toContain(EMULATED_JWT_PREFIX);
    expect(text).not.toContain(FORGE_SECRET);
    expect(text).not.toContain(APPLY_ROLE);
    expect(text).not.toContain("apply-client");
    for (const v of OIDC_REQUEST_VARS) expect(text).not.toMatch(new RegExp(`^${v}=`, "m"));
    // The credentials file is gone once sourced.
    expect(readFileSync(seen, "utf-8")).not.toContain("chant-cloud-4296.sh=");
    expect(() => readFileSync(join(dir, "chant-cloud-4296.sh"))).toThrow();
  });
});
