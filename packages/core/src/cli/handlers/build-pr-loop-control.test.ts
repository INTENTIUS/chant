/**
 * `chant build --pr-loop --control <repo> --control-setting <key>=<value>`
 * (#4772): the build takes the control repo and its read secret, so the
 * note job it writes reads the control repo's records itself, and no
 * product splices `productPipelineJobs(...).post.control` into the file.
 */
import { describe, expect, test, vi } from "vitest";
import { parseYAML } from "../../yaml";
import { parseArgs } from "../parse-args";
import { prLoopFlagsProblem } from "./build";
import { controlNoteCheckout } from "../../control/dispatch";
import { productPipelineJobs } from "../../components/product-pipeline";
import type { DriverComponent } from "../../components/driver";

const generateComponentsPipelineMock = vi.fn(async () => ({ success: true, yaml: "x", stages: [], jobs: [] }));
vi.mock("../../components/cli-support", () => ({ generateComponentsPipeline: (...a: unknown[]) => generateComponentsPipelineMock(...(a as [])) }));
vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfigUpward: async () => ({ config: {} }) };
});
vi.mock("../plugins", async () => {
  const actual = await vi.importActual<typeof import("../plugins")>("../plugins");
  return { ...actual, resolveProjectLexicons: async () => [] };
});

const { runBuild } = await import("./build");

const CONTROL = ["--control", "github.com/acme/control", "--control-setting", "op=deploy", "--control-setting", "member=network", "--control-setting", "readTokenSecret=PLYWOOD_CONTROL_READ"];
const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];

async function options(forge: string, extra: string[] = []): Promise<{ code: number; options: Record<string, unknown> | undefined; err: string }> {
  generateComponentsPipelineMock.mockClear();
  const err: string[] = [];
  vi.spyOn(console, "error").mockImplementation((s: string) => void err.push(String(s)));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const code = await runBuild({ args: parseArgs(["build", ".", "--components", "--generate", forge, "--pr-loop", ...extra]) } as never);
  const call = generateComponentsPipelineMock.mock.calls[0] as unknown[] | undefined;
  return { code, options: call?.[2] as Record<string, unknown> | undefined, err: err.join("\n") };
}

describe("build --pr-loop --control", () => {
  test("hands the generator the control target, with the read secret", async () => {
    const { code, options: o } = await options("github", CONTROL);
    expect(code).toBe(0);
    const control = (o!.prLoop as { control: { target: Record<string, unknown> } }).control;
    expect(control.target).toMatchObject({ repo: "github.com/acme/control", forge: "github", op: "deploy", member: "network", readTokenSecret: "PLYWOOD_CONTROL_READ" });
  });

  for (const forge of ["github", "forgejo", "gitlab"] as const) {
    test(`the ${forge} note job carries the read, the step productPipelineJobs hands back as post.control`, async () => {
      const { options: o } = await options(forge, CONTROL);
      const prLoop = o!.prLoop as { control: { target: import("../../control/dispatch").ControlTarget } };
      const step = controlNoteCheckout(forge, prLoop.control.target);
      expect(productPipelineJobs(forge, "prod", { words: { commands: {} }, control: { target: prLoop.control.target } }).post.control).toEqual(step);
      const lexicon = forge === "gitlab" ? "gitlab" : "github";
      const gen = (await import(`@intentius/chant-lexicon-${lexicon}/components/generate-pipeline`)) as Record<string, (c: DriverComponent[], o: unknown) => { yaml: string }>;
      const { yaml } = forge === "gitlab" ? gen.generateGitlabPipeline!(ESTATE, o) : gen.generateGithubPipeline!(ESTATE, { ...o, prLoop: { ...prLoop, forge } });
      const note = (parseYAML(yaml) as Record<string, unknown> & { jobs?: Record<string, unknown> });
      const job = JSON.stringify(forge === "gitlab" ? note["plan-note"] : note.jobs!["plan-note"]);
      expect(job).toContain(JSON.stringify(step.script).slice(1, -1));
      if (forge !== "gitlab") expect(job).toContain("secrets.PLYWOOD_CONTROL_READ");
      else expect(job).toContain("PLYWOOD_CONTROL_READ");
    });
  }

  test("without --control no control reaches the generator", async () => {
    const { options: o } = await options("github");
    expect((o!.prLoop as Record<string, unknown>).control).toBeUndefined();
  });

  test("refuses settings that do not hold, and the flags without --pr-loop", async () => {
    const missing = await options("github", ["--control", "github.com/acme/control"]);
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/control\.op must name the Op/);
    expect(missing.err).toMatch(/control\.member must name this repo/);
    const same = await options("github", [...CONTROL, "--control-setting", "tokenSecret=PLYWOOD_CONTROL_READ"]);
    expect(same.err).toMatch(/must not be the dispatch token's secret/);
    expect(() => parseArgs(["build", "--control-setting", "color=blue"])).toThrow(/--control-setting needs <key>=<value>/);
    expect(prLoopFlagsProblem({ controlRepo: "github.com/acme/control" })).toMatch(/--control .*needs --pr-loop/);
    expect(prLoopFlagsProblem({ prLoop: true, controlSettings: { op: "deploy" } })).toMatch(/needs --control <repo>/);
  });
});

test("PR_LOOP_CONTROL_FLOOR marks it in the ci-product entry", async () => {
  const ciProduct = await import("../../ci-product");
  const { NEXT_RELEASE } = await import("../../release-floors");
  expect((ciProduct as Record<string, unknown>).PR_LOOP_CONTROL_FLOOR).toBe(NEXT_RELEASE);
});
