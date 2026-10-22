/**
 * #4295: in the generated pull-request workflow, no step that runs the pull
 * request's code holds a forge token. The plan job uses the job's token for
 * its checkout's fetches alone, every later step starts without the token
 * variables, and the plan step is the job's last and hands its report on as
 * the job's outputs. The plan-note job, which runs none of the change's
 * code, posts.
 *
 * The behaviour tests run the generated steps with `sh`, as a forge runs
 * them, with every token variable set, and `chant ci run plan` replaced by a
 * line that prints what the step can see.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { dropForgeTokens, FORGE_TOKEN_VARS } from "@intentius/chant/ci-handover";
import { generateGithubPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [
  { name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] },
  { name: "app", dependsOn: ["net"], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "app" }] }] },
];

interface Step {
  name?: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string[];
  if?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const SECRET = "ghs_generated_job_secret_4295";
const TOKENS = Object.fromEntries(FORGE_TOKEN_VARS.map((v) => [v, `${SECRET}_${v}`]));
const BASE = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" };
const PLAN_LINE = /^chant ci run plan .*$/m;

/** The pipeline with a build, a before-script line and an after-script line, so every kind of step is there. */
function workflow(extra: Record<string, unknown> = {}): { jobs: Record<string, Job> } {
  const { yaml } = generateGithubPipeline(ESTATE, { env: "prod", image: "example/ci:1", beforeScript: ["npm ci"], extraScript: ["echo after"], prLoop: { build: true, ...extra } });
  return parseYAML(yaml) as { jobs: Record<string, Job> };
}

describe("the generated plan job holds no forge token while the change's code runs (#4295)", () => {
  const doc = workflow();
  const plan = doc.jobs.plan!;
  const note = doc.jobs["plan-note"]!;

  test("only the checkout step is given the job's token, and only for its fetches", () => {
    const [checkout, ...rest] = plan.steps;
    expect(checkout!.uses).toBeUndefined();
    expect(checkout!.env).toEqual({ CHANT_CHECKOUT_TOKEN: "${{ github.token }}" });
    for (const step of rest) {
      expect(JSON.stringify(step)).not.toContain("github.token");
      for (const name of FORGE_TOKEN_VARS) expect(step.env ?? {}).not.toHaveProperty(name);
    }
    // The token itself can read the repository and nothing else.
    expect(plan.permissions).toEqual({ contents: "read" });
  });

  test("every step after the checkout starts by dropping the token variables, and none is an action", () => {
    for (const step of plan.steps.slice(1)) {
      expect(step.uses).toBeUndefined();
      expect(step.run!.split("\n")[0]).toBe(dropForgeTokens("sh"));
    }
  });

  test("the plan step is the job's last: no upload, cache or checkout post step runs after the change's code", () => {
    const last = plan.steps.at(-1)!;
    expect(last.id).toBe("plan");
    expect(last.run).toMatch(PLAN_LINE);
    // The after-script lines run inside it, not as steps of their own.
    expect(last.run!.trimEnd().split("\n").at(-1)).toBe("echo after");
    expect(plan.outputs).toEqual({ report_0: "${{ steps.plan.outputs.report_0 }}" });
  });

  test("the plan-note job checks out the target branch's commit, and only it can write the note and the status", () => {
    expect(note.needs).toEqual(["plan"]);
    expect(note.if).toContain("needs.plan.result == 'failure'");
    expect(note.steps[0]).toMatchObject({ uses: expect.stringMatching(/^actions\/checkout@/), with: { ref: "${{ github.event.pull_request.base.sha }}" } });
    expect(note.permissions).toEqual({ actions: "read", contents: "read", "pull-requests": "write", statuses: "write" });
    const post = note.steps.at(-1)!;
    expect(post.env).toMatchObject({ GITHUB_TOKEN: "${{ github.token }}", HEAD_SHA: "${{ github.sha }}", PLAN_RESULT: "${{ needs.plan.result }}" });
    expect(post.run).toBe('chant components pr-post --pr "$PR_NUMBER" --head "$HEAD_SHA" --env prod --output .chant/pr --forge github --result "$PLAN_RESULT"');
    // The note job runs no build, no lint and no plan: none of the change's code.
    expect(JSON.stringify(note)).not.toMatch(/chant (build|lint|ci run)/);
  });
});

/** Run one generated step as a forge does: its script as a file, `sh -e`, with the job's tokens in the environment. */
function runStep(step: Step, cwd: string, env: Record<string, string>): number | null {
  const file = join(cwd, "..", `step-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(file, step.run!);
  return spawnSync("sh", ["-e", file], { cwd, env: { ...BASE, ...TOKENS, ...env }, encoding: "utf-8" }).status;
}

describe("the generated steps, run, see no forge token and hand the report on (#4295)", () => {
  const doc = workflow();

  test("each step after the checkout, and every process it starts, sees none of the token variables", () => {
    const top = mkdtempSync(join(tmpdir(), "chant-generated-step-"));
    dirs.push(top);
    const work = join(top, "work");
    mkdirSync(work);
    const seen = join(top, "seen");
    mkdirSync(seen);
    const output = join(top, "github-output");
    const steps = doc.jobs.plan!.steps.slice(1);
    steps.forEach((step, i) => {
      // The step's own lines become a probe; the plan line also writes a report, as pr-plan would.
      const probe = `env > "${seen}/${i}.env"; sh -c 'env' >> "${seen}/${i}.env"`;
      const report = 'mkdir -p .chant/pr && echo \'{"stage":"plan"}\' > .chant/pr/pr-plan.json && echo note > .chant/pr/pr-note.md';
      // The generated drop line and hand-on lines run as they are; the step's own commands become the probe.
      const lines = step.run!.split("\n");
      const handover = lines.filter((l) => l.startsWith("chant_report=") || l.startsWith("chant_handover") || l.startsWith("trap "));
      const body = [lines[0], ...handover, probe, ...(PLAN_LINE.test(step.run!) ? [report] : [])].join("\n");
      const status = runStep({ run: body }, work, { GITHUB_OUTPUT: output, BASE_SHA: "b".repeat(40), PR_NUMBER: "7" });
      expect(status, step.name ?? step.run!.split("\n")[1]).toBe(0);
    });
    for (let i = 0; i < steps.length; i++) {
      const env = readFileSync(join(seen, `${i}.env`), "utf-8");
      expect(env).not.toContain(SECRET);
    }
    // The plan step handed its report on as the job's output.
    expect(readFileSync(output, "utf-8")).toMatch(/^report_0=\S+$/m);
  });

  test("the note job's take-over step writes the plan step's report back from that output", () => {
    const top = mkdtempSync(join(tmpdir(), "chant-generated-note-"));
    dirs.push(top);
    const work = join(top, "work");
    mkdirSync(join(work, ".chant", "pr"), { recursive: true });
    writeFileSync(join(work, ".chant", "pr", "pr-plan.json"), '{"stage":"plan"}\n');
    const output = join(top, "github-output");
    const planStep = doc.jobs.plan!.steps.at(-1)!;
    const handOn = planStep.run!.split("\n").filter((l, n) => n === 0 || l.startsWith("chant_report=") || l.startsWith("chant_handover") || l.startsWith("trap ")).join("\n");
    expect(runStep({ run: handOn }, work, { GITHUB_OUTPUT: output })).toBe(0);
    const value = readFileSync(output, "utf-8").trim().slice("report_0=".length);

    const noteWork = join(top, "note");
    mkdirSync(noteWork);
    const take = doc.jobs["plan-note"]!.steps.find((s) => s.name === "Take the plan report from the plan job")!;
    // The forge fills the expression with toJSON of the output: a JSON string on one line.
    const filled = take.run!.replace("${{ toJSON(needs.plan.outputs.report_0) }}", JSON.stringify(value));
    expect(runStep({ run: filled }, noteWork, {})).toBe(0);
    expect(existsSync(join(noteWork, ".chant", "pr", "pr-plan.json"))).toBe(true);
    expect(readFileSync(join(noteWork, ".chant", "pr", "pr-plan.json"), "utf-8")).toBe('{"stage":"plan"}\n');
  });
});
