/**
 * #5021: after the product plan's login (or with `idTokens`), the plan and
 * re-plan jobs' later steps start without the variables a token is
 * requested with, on GitHub and on Forgejo, where
 * `ACTIONS_ID_TOKEN_REQUEST_TOKEN` is the run's own token. The tests run
 * the rendered steps as a runner runs them (`sh -e <file>`, each step with
 * the request variables and a forge token in its environment, and
 * `GITHUB_ENV` carried to the next), against the local emulator of the
 * forge's token URL (`@intentius/chant/__fixtures__/oidc-emulator`). The
 * plan verb is a probe: what its process sees, and whether it can ask the
 * forge for a token. Test values only; no forge or cloud is reached.
 */
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { EMULATED_JWT_PREFIX, EMULATED_REQUEST_TOKEN, startOidcEmulator, type OidcEmulator } from "@intentius/chant/__fixtures__/oidc-emulator";
import { generateProductPlanPipeline } from "@intentius/chant-lexicon-github/components/product-plan-pipeline";
import { generateForgejoProductPlanPipeline } from "./product-plan-pipeline";

const run = promisify(execFile);

const words = {
  product: "terragucci",
  noun: ["root", "roots"] as [string, string],
  commands: { plan: "plan" as const },
  approve: "terragucci approve {gate} --plan {digest} {sign}",
  op: "tf-apply",
  gateName: "wave-{k}",
  approval: "per-wave" as const,
  bin: "terragucci chant",
};

const FORGE_SECRET = "forge-secret-5021";
const CLIENT_ID = "11111111-1111-1111-1111-111111111111";
const TENANT_ID = "00000000-0000-0000-0000-000000000001";

/** The probe each step runs in place of the change's code: its environment, a child's, and a request for a token. */
const PROBE = [
  'env > "$SEEN/$1"',
  `node -e 'const u=process.env.ACTIONS_ID_TOKEN_REQUEST_URL,k=process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;if(!u||!k){console.log("request:none");process.exit(0)}fetch(u+"&audience=x",{headers:{authorization:"bearer "+k}}).then(r=>r.text()).then(t=>console.log("request:"+t))' >> "$SEEN/$1"`,
].join("\n");

type Step = { name?: string; id?: string; uses?: string; run?: string; env?: Record<string, string> };
type Job = { permissions?: Record<string, string>; steps: Step[] };

let emu: OidcEmulator;
const dirs: string[] = [];
beforeAll(async () => {
  emu = await startOidcEmulator();
});
afterAll(async () => {
  await emu.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const FORGES = ["github", "forgejo"] as const;
type Forge = (typeof FORGES)[number];

function workflow(forge: Forge, plan: Record<string, unknown>): Record<string, Job> {
  const options = {
    words,
    image: "example/ci:1",
    beforeScript: ["sh ./probe.sh setup-line"],
    productPlan: {
      command: "sh ./probe.sh plan {output}",
      setup: [{ name: "Warm up", run: "sh ./probe.sh setup" }],
      targets: [{ name: "prod", writeProbe: "sh ./probe.sh probe" }],
      replan: true,
      ...plan,
    },
  };
  const { doc } = forge === "github" ? generateProductPlanPipeline("default", options) : generateForgejoProductPlanPipeline("default", options);
  return doc.jobsDoc as Record<string, Job>;
}

const parseEnv = (text: string): Record<string, string> =>
  Object.fromEntries(text.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

/**
 * Runs `steps` as one job's steps on a runner that gives each the token
 * request variables and a forge token: `GITHUB_ENV`'s lines go to the
 * steps after the one that wrote them. Returns what each probe saw.
 */
async function runSteps(forge: Forge, steps: Step[]): Promise<{ seen: Record<string, string>; minted: number }> {
  const top = mkdtempSync(join(tmpdir(), "chant-plan-login-5021-"));
  dirs.push(top);
  const work = join(top, "work");
  const seen = join(top, "seen");
  const temp = join(top, "temp");
  for (const d of [work, seen, temp]) mkdirSync(d);
  writeFileSync(join(work, "probe.sh"), PROBE + "\n");
  const githubEnv = join(top, "github-env");
  writeFileSync(githubEnv, "");
  // Forgejo's request token is the run's own token.
  const runner = { PATH: process.env.PATH!, ...emu.requestEnv, GITHUB_TOKEN: FORGE_SECRET, ...(forge === "forgejo" ? { FORGEJO_TOKEN: FORGE_SECRET } : {}), RUNNER_TEMP: temp, GITHUB_ENV: githubEnv, GITHUB_OUTPUT: join(top, "github-output"), SEEN: seen };
  const before = emu.log.minted.length;
  for (const [i, step] of steps.entries()) {
    const file = join(top, `step-${i}.sh`);
    writeFileSync(file, step.run! + "\n");
    const r = await run("sh", ["-e", file], { cwd: work, env: { ...runner, ...parseEnv(readFileSync(githubEnv, "utf8")), ...(step.env ?? {}) } }).catch((e: { stderr: string; code: number }) => ({ stderr: e.stderr, failed: e.code }));
    expect(r, `${step.name ?? step.run}: ${(r as { stderr: string }).stderr}`).not.toHaveProperty("failed");
  }
  const out: Record<string, string> = {};
  for (const name of ["setup", "setup-line", "probe", "plan"]) out[name] = readFileSync(join(seen, name), "utf8");
  return { seen: out, minted: emu.log.minted.length - before };
}

/** The steps a plan or re-plan job runs after its checkout. */
const afterCheckout = (job: Job): Step[] => job.steps.slice(job.steps.findIndex((s) => /^Check out the (change|pull request's head)$/.test(s.name ?? "")) + 1);

const holdsNothing = (text: string) => {
  expect(text).toContain("request:none");
  expect(text).not.toMatch(/^ACTIONS_ID_TOKEN_REQUEST_(URL|TOKEN)=/m);
  expect(text).not.toContain(EMULATED_REQUEST_TOKEN);
  expect(text).not.toContain(EMULATED_JWT_PREFIX);
  expect(text).not.toContain(FORGE_SECRET);
};

describe("the product plan after a login: the change's code holds no token request (#5021)", () => {
  test.each(FORGES)("%s: the login asks for the token; the setup, the probe and the plan verb's process start without the request variables, in the plan and the re-plan job", async (forge) => {
    const jobs = workflow(forge, { login: { azure: { clientId: CLIENT_ID, tenantId: TENANT_ID } } });
    for (const name of ["plan-prod", "replan-prod"]) {
      const steps = afterCheckout(jobs[name]!);
      expect(steps.map((s) => s.name ?? "")).toContain("Cloud login (chant ci-login: azure)");
      const { seen, minted } = await runSteps(forge, steps);
      // The login asked for one token, and nothing after it could.
      expect(minted).toBe(1);
      for (const text of Object.values(seen)) holdsNothing(text);
      // The plan verb has the login's variables and its token file.
      const plan = parseEnv(seen.plan!);
      expect(plan.AZURE_CLIENT_ID).toBe(CLIENT_ID);
      expect(plan.AZURE_FEDERATED_TOKEN_FILE).toMatch(/chant-oidc-azure-/);
    }
  });

  test.each(FORGES)("%s: the login's step alone keeps the request variables; every other step after the checkout restarts without them", (forge) => {
    const jobs = workflow(forge, { login: { aws: { role: "arn:aws:iam::111111111111:role/plan" } } });
    for (const name of ["plan-prod", "replan-prod"]) {
      for (const step of afterCheckout(jobs[name]!)) {
        const first = step.run!.split("\n")[0]!;
        if (step.name?.startsWith("Cloud login")) expect(first).not.toContain("ACTIONS_ID_TOKEN_REQUEST");
        else expect(first, step.name).toContain("-u ACTIONS_ID_TOKEN_REQUEST_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_URL");
      }
    }
  });

  test.each(FORGES)("%s: a product's own idTokens leave the request variables to the plan verb alone, which asks the forge for them", async (forge) => {
    const jobs = workflow(forge, { idTokens: { AWS_ID_TOKEN: "sts.amazonaws.com" } });
    const { seen, minted } = await runSteps(forge, afterCheckout(jobs["plan-prod"]!));
    for (const name of ["setup", "setup-line", "probe"]) holdsNothing(seen[name]!);
    expect(seen.plan).toMatch(/^ACTIONS_ID_TOKEN_REQUEST_URL=/m);
    expect(seen.plan).toContain(`request:`);
    expect(seen.plan).not.toContain("request:none");
    expect(minted).toBe(1);
  });

  test.each(FORGES)("%s: a job with no login and no token request keeps its steps as before", (forge) => {
    const jobs = workflow(forge, {});
    for (const step of afterCheckout(jobs["plan-prod"]!)) expect(step.run!.split("\n")[0]).not.toContain("ACTIONS_ID_TOKEN_REQUEST");
  });
});
