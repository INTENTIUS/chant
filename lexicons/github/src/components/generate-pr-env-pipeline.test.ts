/**
 * A pull request's environment in the generated GitHub workflow (#4298):
 * `env-up` on an opened, updated or reopened pull request, `env-post` after
 * it, `env-down` when it closes, `env-sweep` on the schedule, and a plan job
 * that skips the close.
 *
 * `env-up` runs the pull request's code, so it follows the handover (#4295):
 * only its checkout sees the job's token, every later step starts without
 * the token variables, and the `pr-env up` step is last and hands its report
 * and record on. The behaviour test runs the generated steps with `sh`, as a
 * forge runs them, with every token variable set.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { dropForgeTokens, FORGE_TOKEN_VARS } from "@intentius/chant/ci-handover";
import { PR_ENV_SWEEP_CRON } from "@intentius/chant/components/pr-pipeline";
import { generateGithubPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "app", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "kubectl-apply", manifest: "app.yaml" } as never] }] }];

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
  if: string;
  needs?: string[];
  permissions: Record<string, string>;
  outputs?: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  steps: Step[];
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const SECRET = "ghs_generated_env_secret_4298";
const TOKENS = Object.fromEntries(FORGE_TOKEN_VARS.map((v) => [v, `${SECRET}_${v}`]));
const BASE = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp" };
const UP_LINE = /^chant components pr-env up .*$/m;

function hasActionlint(): boolean {
  try {
    execFileSync("actionlint", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function workflow(): { yaml: string; jobs: string[]; doc: { on: Record<string, unknown>; jobs: Record<string, Job> } } {
  const result = generateGithubPipeline(ESTATE, { env: "staging", image: "example/ci:1", beforeScript: ["npm ci"], extraScript: ["echo after"], prLoop: { prEnvironment: true, build: true } });
  return { yaml: result.yaml, jobs: result.jobs.map((j) => j.jobName), doc: parseYAML(result.yaml) as { on: Record<string, unknown>; jobs: Record<string, Job> } };
}

describe("the GitHub pull-request workflow with a pull request environment", () => {
  const { yaml, jobs, doc } = workflow();

  test("the pull_request trigger fires on close too, and a schedule starts the sweep", () => {
    expect(doc.on.pull_request).toEqual({ branches: ["main"], types: ["opened", "synchronize", "reopened", "closed"] });
    expect(doc.on.schedule).toEqual([{ cron: PR_ENV_SWEEP_CRON }]);
    expect(doc.jobs.plan!.if).toBe("github.event_name == 'pull_request' && github.event.action != 'closed'");
    expect(jobs).toEqual(expect.arrayContaining(["env-up", "env-post", "env-down", "env-sweep"]));
  });

  test("env-up plans pr-<n> with no forge and no push; env-down tears it down from the base branch", () => {
    const up = doc.jobs["env-up"]!;
    const down = doc.jobs["env-down"]!;
    expect(up.if).toBe("github.event_name == 'pull_request' && github.event.action != 'closed'");
    expect(down.if).toBe("github.event_name == 'pull_request' && github.event.action == 'closed'");
    const last = up.steps.at(-1)!;
    expect(last.run).toMatch(UP_LINE);
    expect(last.run!.match(UP_LINE)![0]).toBe('chant components pr-env up --base "$BASE_SHA" --pr "$PR_NUMBER" --output .chant/pr-env --no-push');
    expect(last.env?.CHANT_ENV).toBe("pr-${{ github.event.pull_request.number }}");
    const downRun = down.steps.find((s) => s.run?.startsWith("chant components pr-env"))!;
    expect(downRun.run).toBe('chant components pr-env down --pr "$PR_NUMBER" --reason closed --forge github --output .chant/pr-env');
    expect(down.steps[0]!.with?.ref).toBe("${{ github.event.pull_request.base.ref }}");
    expect(up.concurrency).toEqual({ group: "chant-pr-env-${{ github.event.pull_request.number }}", "cancel-in-progress": false });
    expect(down.concurrency).toEqual(up.concurrency);
    expect(doc.jobs["env-sweep"]!.if).toBe("github.event_name == 'schedule'");
  });

  test("without the option nothing changes", () => {
    const plain = parseYAML(generateGithubPipeline(ESTATE, { env: "staging", prLoop: {} }).yaml) as { on: Record<string, unknown>; jobs: Record<string, Job> };
    expect(plain.on.pull_request).toEqual({ branches: ["main"] });
    expect(plain.jobs["env-up"]).toBeUndefined();
  });

  test.skipIf(!hasActionlint())("passes actionlint", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-actionlint-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "chant-pr.yml"), yaml);
    expect(() => execFileSync("actionlint", [".github/workflows/chant-pr.yml"], { cwd: dir, encoding: "utf8" })).not.toThrow();
  });
});

describe("env-up holds no forge token while the pull request's code runs (#4295)", () => {
  const { doc } = workflow();
  const up = doc.jobs["env-up"]!;
  const post = doc.jobs["env-post"]!;

  test("only the checkout step is given the job's token, and only for its fetches", () => {
    const [checkout, ...rest] = up.steps;
    expect(checkout!.uses).toBeUndefined();
    expect(checkout!.env).toEqual({ CHANT_CHECKOUT_TOKEN: "${{ github.token }}" });
    for (const step of rest) {
      expect(JSON.stringify(step)).not.toContain("github.token");
      for (const name of FORGE_TOKEN_VARS) expect(step.env ?? {}).not.toHaveProperty(name);
    }
    expect(up.permissions).toEqual({ contents: "read" });
  });

  test("every step after the checkout starts by dropping the token variables, and none is an action", () => {
    for (const step of up.steps.slice(1)) {
      expect(step.uses).toBeUndefined();
      expect(step.run!.split("\n")[0]).toBe(dropForgeTokens("sh"));
    }
  });

  test("the pr-env up step is the job's last and hands its report on as the job's outputs", () => {
    const last = up.steps.at(-1)!;
    expect(last.id).toBe("env-up");
    expect(last.run!.trimEnd().split("\n").at(-1)).toBe("echo after");
    expect(up.outputs).toEqual({ report_0: "${{ steps.env-up.outputs.report_0 }}" });
  });

  test("env-post checks out the target branch's commit, and only it can write the record, the note and the status", () => {
    expect(post.needs).toEqual(["env-up"]);
    expect(post.if).toContain("needs.env-up.result == 'failure'");
    expect(post.steps[0]).toMatchObject({ uses: expect.stringMatching(/^actions\/checkout@/), with: { ref: "${{ github.event.pull_request.base.sha }}" } });
    expect(post.permissions).toEqual({ contents: "write", "pull-requests": "write", statuses: "write" });
    const last = post.steps.at(-1)!;
    expect(last.env).toMatchObject({ GITHUB_TOKEN: "${{ github.token }}", HEAD_SHA: "${{ github.sha }}", UP_RESULT: "${{ needs.env-up.result }}" });
    expect(last.run).toBe('chant components pr-env post --pr "$PR_NUMBER" --head "$HEAD_SHA" --forge github --output .chant/pr-env --result "$UP_RESULT"');
    // The post job runs no build, no lint and no pr-env up: none of the change's code.
    expect(JSON.stringify(post)).not.toMatch(/chant (build|lint)|pr-env up/);
  });
});

/** Run one generated step as a forge does: its script as a file, `sh -e`, with the job's tokens in the environment. */
function runStep(step: Step, cwd: string, env: Record<string, string>): number | null {
  const file = join(cwd, "..", `step-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(file, step.run!);
  return spawnSync("sh", ["-e", file], { cwd, env: { ...BASE, ...TOKENS, ...env }, encoding: "utf-8" }).status;
}

describe("env-up's steps, run, see no forge token and hand the report and record on (#4295)", () => {
  const { doc } = workflow();

  test("each step after the checkout, and every process it starts, sees none of the token variables", () => {
    const top = mkdtempSync(join(tmpdir(), "chant-generated-env-step-"));
    dirs.push(top);
    const work = join(top, "work");
    mkdirSync(work);
    const seen = join(top, "seen");
    mkdirSync(seen);
    const output = join(top, "github-output");
    const steps = doc.jobs["env-up"]!.steps.slice(1);
    steps.forEach((step, i) => {
      const probe = `env > "${seen}/${i}.env"; sh -c 'env' >> "${seen}/${i}.env"`;
      const report = "mkdir -p .chant/pr-env && echo '{\"stage\":\"up\"}' > .chant/pr-env/pr-env-up.json && echo '{\"kind\":\"up\"}' > .chant/pr-env/pr-env-record.json";
      const lines = step.run!.split("\n");
      const handover = lines.filter((l) => l.startsWith("chant_report=") || l.startsWith("chant_handover") || l.startsWith("trap "));
      const body = [lines[0], ...handover, probe, ...(UP_LINE.test(step.run!) ? [report] : [])].join("\n");
      expect(runStep({ run: body }, work, { GITHUB_OUTPUT: output, BASE_SHA: "b".repeat(40), PR_NUMBER: "7" }), step.name ?? lines[1]).toBe(0);
    });
    for (let i = 0; i < steps.length; i++) expect(readFileSync(join(seen, `${i}.env`), "utf-8")).not.toContain(SECRET);
    expect(readFileSync(output, "utf-8")).toMatch(/^report_0=\S+$/m);
  });

  test("env-post's take-over step writes the report and the record back from that output", () => {
    const top = mkdtempSync(join(tmpdir(), "chant-generated-env-post-"));
    dirs.push(top);
    const work = join(top, "work");
    mkdirSync(join(work, ".chant", "pr-env"), { recursive: true });
    writeFileSync(join(work, ".chant", "pr-env", "pr-env-up.json"), '{"stage":"up"}\n');
    writeFileSync(join(work, ".chant", "pr-env", "pr-env-record.json"), '{"kind":"up"}\n');
    const output = join(top, "github-output");
    const upStep = doc.jobs["env-up"]!.steps.at(-1)!;
    const handOn = upStep.run!.split("\n").filter((l, n) => n === 0 || l.startsWith("chant_report=") || l.startsWith("chant_handover") || l.startsWith("trap ")).join("\n");
    expect(runStep({ run: handOn }, work, { GITHUB_OUTPUT: output })).toBe(0);
    const value = readFileSync(output, "utf-8").trim().slice("report_0=".length);

    const postWork = join(top, "post");
    mkdirSync(postWork);
    const take = doc.jobs["env-post"]!.steps.find((s) => s.name === "Take the environment's report from the env-up job")!;
    const filled = take.run!.replace("${{ toJSON(needs.env-up.outputs.report_0) }}", JSON.stringify(value));
    expect(runStep({ run: filled }, postWork, {})).toBe(0);
    expect(existsSync(join(postWork, ".chant", "pr-env", "pr-env-record.json"))).toBe(true);
    expect(readFileSync(join(postWork, ".chant", "pr-env", "pr-env-up.json"), "utf-8")).toBe('{"stage":"up"}\n');
  });
});
