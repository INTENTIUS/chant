/**
 * `chant build --components --generate` inside a workspace member (#2542).
 * Component discovery is stubbed with a fixed graph; the github generator is
 * the real one, so the files checked here are what a user gets. A project
 * outside any workspace is held to its old output byte for byte, and to a
 * snapshot, since level 0 must not move (#2525).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DriverComponent } from "../../components/driver";
import type { ComponentPipelineOptions } from "../../lexicon";
import type { ParsedArgs } from "../registry";
import { generateGithubPipeline } from "@intentius/chant-lexicon-github/components/generate-pipeline";
import { twoMemberWorkspace } from "../../workspace/__fixtures__/two-member-workspace";

const components: DriverComponent[] = [
  { name: "shared-alb", dependsOn: [], deploy: [] },
  { name: "api", dependsOn: ["shared-alb"], deploy: [] },
];

const received: (ComponentPipelineOptions | undefined)[] = [];
vi.mock("../../components/cli-support", () => ({
  generateComponentsPipeline: async (_path: string, _lexicon: string, options?: ComponentPipelineOptions) => {
    received.push(options);
    const { yaml, stages, jobs, env } = generateGithubPipeline(components, options);
    return { success: true, yaml, stages, jobs, env };
  },
}));
vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfigUpward: async () => ({ config: {} }) };
});

const { runBuild } = await import("./build");

function args(overrides: Partial<ParsedArgs>): ParsedArgs {
  return {
    command: "build",
    path: ".",
    format: "",
    fix: false,
    watch: false,
    verbose: false,
    help: false,
    live: false,
    components: true,
    generate: "github",
    ...overrides,
  };
}

let repo: string;
let logs: string[];
beforeEach(() => {
  received.length = 0;
  logs = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation((s: string) => {
    logs.push(s);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
});

describe("a project inside a workspace member", () => {
  beforeEach(() => {
    repo = twoMemberWorkspace();
  });

  test("the pipeline is written to the member's file at the repository root, filtered and recorded", async () => {
    expect(await runBuild({ args: args({ path: join(repo, "services/api"), env: "staging" }), plugins: [], serializers: [] })).toBe(0);

    expect(received[0]?.member).toEqual({ name: "api", dir: "services/api", file: ".github/workflows/chant-api-staging.yml" });
    const file = join(repo, ".github/workflows/chant-api-staging.yml");
    const text = readFileSync(file, "utf-8");
    const [header, ...rest] = text.split("\n");
    expect(header).toContain("Regenerate with: chant build --components --generate github --env staging");
    expect(rest.join("\n")).toBe(generateGithubPipeline(components, { env: "staging", member: received[0]!.member }).yaml);
    expect(text).toContain("working-directory: services/api");

    const record = JSON.parse(readFileSync(join(repo, "services/api/.chant/generated.json"), "utf-8"));
    expect(record.files).toEqual([{ path: ".github/workflows/chant-api-staging.yml", command: "chant build --components --generate github --env staging", env: "staging" }]);
  });

  test("two members write two files and never collide", async () => {
    await runBuild({ args: args({ path: join(repo, "services/api"), env: "prod" }), plugins: [], serializers: [] });
    await runBuild({ args: args({ path: join(repo, "apps/web"), env: "prod" }), plugins: [], serializers: [] });
    expect(existsSync(join(repo, ".github/workflows/chant-api-prod.yml"))).toBe(true);
    expect(existsSync(join(repo, ".github/workflows/chant-web-prod.yml"))).toBe(true);
  });

  test("--format json names the member and the file and writes nothing", async () => {
    expect(await runBuild({ args: args({ path: join(repo, "apps/web"), env: "prod", format: "json" }), plugins: [], serializers: [] })).toBe(0);
    const out = JSON.parse(logs.join("\n"));
    expect(out).toMatchObject({ member: "web", file: ".github/workflows/chant-web-prod.yml", env: "prod" });
    expect(existsSync(join(repo, ".github/workflows/chant-web-prod.yml"))).toBe(false);
  });

  test("an example project in a group is not a member, and gets the plain pipeline", async () => {
    expect(await runBuild({ args: args({ path: join(repo, "examples/demo") }), plugins: [], serializers: [] })).toBe(0);
    expect(received[0]).toEqual({ env: undefined });
    expect(logs.join("\n")).toBe(generateGithubPipeline(components, {}).yaml);
  });
});

describe("a project outside any workspace (level 0)", () => {
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "chant-build-level0-")));
    execFileSync("git", ["init", "-q"], { cwd: repo });
  });

  test("the pipeline is the generator's output, unchanged", async () => {
    const output = join(repo, "pipeline.yml");
    expect(await runBuild({ args: args({ path: repo, env: "staging", output }), plugins: [], serializers: [] })).toBe(0);
    expect(received[0]).toEqual({ env: "staging" });
    const text = readFileSync(output, "utf-8");
    expect(text).toBe(generateGithubPipeline(components, { env: "staging" }).yaml);
    expect(text).toMatchSnapshot();
    expect(existsSync(join(repo, ".chant"))).toBe(false);
  });
});
