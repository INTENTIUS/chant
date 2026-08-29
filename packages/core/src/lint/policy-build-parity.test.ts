/**
 * chant #2002 — the `policyGate` Op step must gate on the build `chant build`
 * produces, not on a different one.
 *
 * `evaluateProjectPolicies` used to assemble `build()`'s options itself, two of
 * them against `buildCommand`'s nine. It built with fold off (the path #1134
 * retired as the default), without the project's config (so serializers lost
 * their lexicon-scoped dialect settings) and without `buildRoots` (so
 * config-declared roots contributed nothing) — a gate could pass a build `chant
 * build` fails. Both callers now assemble through
 * `../cli/build-options.ts`'s `resolveProjectBuildOptions`, and the first test
 * below fails if either ever grows an option the other does not get.
 *
 * `build()` is wrapped rather than replaced: every assertion here is about a
 * real build of a real fixture, and the wrapper only records what each caller
 * asked for.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BuildOptions, BuildResult } from "../build";

const recorder = vi.hoisted(() => ({
  options: [] as (BuildOptions | undefined)[],
  results: [] as BuildResult[],
}));

vi.mock("../build", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../build")>();
  return {
    ...actual,
    build: async (...args: Parameters<typeof actual.build>) => {
      recorder.options.push(args[3]);
      const result = await actual.build(...args);
      recorder.results.push(result);
      return result;
    },
  };
});

const { evaluateProjectPolicies } = await import("./policy");
const { buildCommand } = await import("../cli/commands/build");
const { resolveProjectLexicons, loadPlugins } = await import("../cli/plugins");

/** Run `chant build` over a fixture the way `cli/main.ts` drives it. */
async function runChantBuild(dir: string): Promise<{ options: BuildOptions; result: BuildResult }> {
  const plugins = await loadPlugins(await resolveProjectLexicons(dir));
  recorder.options.length = 0;
  recorder.results.length = 0;
  const outcome = await buildCommand({
    path: dir,
    format: "json",
    output: join(dir, "out", "build.json"),
    serializers: plugins.map((p) => p.serializer),
    plugins,
  });
  expect(outcome.errors).toEqual([]);
  return { options: recorder.options[0]!, result: recorder.results[0]! };
}

/** Run the `policyGate` step's entry point over the same fixture. */
async function runPolicyGate(dir: string): Promise<{ options: BuildOptions; result: BuildResult }> {
  recorder.options.length = 0;
  recorder.results.length = 0;
  await evaluateProjectPolicies({ path: dir });
  return { options: recorder.options[0]!, result: recorder.results[0]! };
}

/** Build-root contributors are freshly bound closures — compare their count. */
function comparable(options: BuildOptions): Record<string, unknown> {
  return { ...options, buildRoots: options.buildRoots?.length ?? 0 };
}

const TRIVIAL_POLICY =
  `export const check = {\n` +
  `  id: "ORG-PARITY",\n` +
  `  description: "records nothing; the build is what is under test",\n` +
  `  check: () => [],\n` +
  `};\n`;

describe("policyGate builds the same project chant build does (chant #2002)", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `chant-policy-parity-${Date.now()}-${Math.random()}`);
    await mkdir(join(testDir, "policies"), { recursive: true });
    await writeFile(join(testDir, "policies", "org.ts"), TRIVIAL_POLICY);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /**
   * A forgejo project: `forgejo.runnerLabels` is read by the serializer off
   * `SerializeContext.config` (lexicons/forgejo/src/serializer.ts), so a build
   * that drops `config` emits the default label instead of the project's.
   */
  async function writeForgejoProject(): Promise<void> {
    await writeFile(
      join(testDir, "chant.config.ts"),
      `export default {\n` +
        `  lexicons: ["forgejo"],\n` +
        `  forgejo: { runnerLabels: { "ubuntu-latest": "self-hosted-arm64" } },\n` +
        `  lint: { policies: ["policies/org.ts"] },\n` +
        `};\n`,
    );
    await writeFile(
      join(testDir, "ci.ts"),
      `import { Workflow, Job, Step } from "@intentius/chant-lexicon-github";\n` +
        `export const workflow = new Workflow({ name: "CI", on: { push: {} } });\n` +
        `export const buildJob = new Job({\n` +
        `  "runs-on": "ubuntu-latest",\n` +
        `  steps: [new Step({ name: "Build", run: "npm run build" })],\n` +
        `});\n`,
    );
  }

  test("both callers hand build() the identical option set", async () => {
    await writeForgejoProject();

    const cli = await runChantBuild(testDir);
    const gate = await runPolicyGate(testDir);

    // The drift this issue is about is an option one caller passes and the
    // other does not, so the key sets are asserted on their own — a new option
    // added at one call site fails here even if its value happens to match.
    expect(Object.keys(gate.options).sort()).toEqual(Object.keys(cli.options).sort());
    expect(comparable(gate.options)).toEqual(comparable(cli.options));
    expect(gate.options.fold).toBe(true);
  });

  test("the project's lexicon-scoped dialect settings reach the gate's serializers", async () => {
    await writeForgejoProject();

    const cli = await runChantBuild(testDir);
    const gate = await runPolicyGate(testDir);

    expect([...gate.result.outputs.entries()]).toEqual([...cli.result.outputs.entries()]);
    const emitted = JSON.stringify([...gate.result.outputs.values()]);
    // The project's own label, not `DEFAULT_RUNNER_LABELS`' "docker" — which is
    // what the gate emitted while it built without `config`.
    expect(emitted).toContain("self-hosted-arm64");
    expect(emitted).not.toContain("docker");
  });

  test("entities from a config-declared build root are in the set the gate sees", async () => {
    await writeFile(
      join(testDir, "chant.config.ts"),
      `export default { lexicons: ["cedar"], lint: { policies: ["policies/org.ts"] } };\n`,
    );
    // cedar's buildRoots hook contributes the project's schema as an entity
    // (lexicons/cedar/src/schema-artifact.ts). Without `buildRoots` the gate
    // never saw it, so a policy over it could not fail.
    await writeFile(join(testDir, "schema.cedarschema"), `entity User;\n`);

    const cli = await runChantBuild(testDir);
    const gate = await runPolicyGate(testDir);

    expect([...gate.result.entities.keys()].sort()).toEqual([...cli.result.entities.keys()].sort());
    expect([...gate.result.entities.keys()]).toContain("cedarSchema");
    expect([...gate.result.outputs.entries()]).toEqual([...cli.result.outputs.entries()]);
  });

  test("a foldable source module does not execute during the gate's build", async () => {
    delete process.env.CHANT_2002_SOURCE_RAN;
    await writeFile(
      join(testDir, "chant.config.ts"),
      `export default { lexicons: ["k8s"], lint: { policies: ["policies/org.ts"] } };\n`,
    );
    await writeFile(
      join(testDir, "ns.ts"),
      // Module-level: runs if and only if the file is imported. Fold reads the
      // constructor call statically and never imports the module.
      `process.env.CHANT_2002_SOURCE_RAN = "1";\n` +
        `import { Namespace } from "@intentius/chant-lexicon-k8s";\n` +
        `export const ns = new Namespace({ metadata: { name: "demo" } });\n`,
    );

    const gate = await runPolicyGate(testDir);

    expect(gate.options.fold).toBe(true);
    expect(gate.result.foldDecisions.find((d) => d.file.endsWith("ns.ts"))?.mode).toBe("fold");
    expect(process.env.CHANT_2002_SOURCE_RAN).toBeUndefined();
  });

  test("build.fold: false is honoured too — the config decides, not the gate", async () => {
    delete process.env.CHANT_2002_SOURCE_RAN;
    await writeFile(
      join(testDir, "chant.config.ts"),
      `export default { lexicons: ["k8s"], build: { fold: false }, lint: { policies: ["policies/org.ts"] } };\n`,
    );
    // No lexicon import: with fold off every discovered file is imported, and
    // this fixture lives outside the repo where a bare `@intentius/*`
    // specifier does not resolve. The marker is all this test needs.
    await writeFile(join(testDir, "marker.ts"), `process.env.CHANT_2002_SOURCE_RAN = "1";\nexport const value = 1;\n`);

    const gate = await runPolicyGate(testDir);

    expect(gate.options.fold).toBe(false);
    expect(process.env.CHANT_2002_SOURCE_RAN).toBe("1");
    delete process.env.CHANT_2002_SOURCE_RAN;
  });

  test("build.sandbox: true is reported as a divergence rather than silently ignored", async () => {
    await writeFile(
      join(testDir, "chant.config.ts"),
      `export default { lexicons: ["k8s"], build: { sandbox: true }, lint: { policies: ["policies/org.ts"] } };\n`,
    );
    const stderr: string[] = [];
    vi.spyOn(console, "error").mockImplementation((s: string) => { stderr.push(s); });

    const evaluation = await evaluateProjectPolicies({ path: testDir });

    expect(evaluation.warnings).toHaveLength(1);
    expect(evaluation.warnings[0]).toContain("build.sandbox is enabled");
    expect(stderr.join("\n")).toContain("build.sandbox is enabled");
  });

  test("no sandbox opt-in, no warning", async () => {
    await writeFile(
      join(testDir, "chant.config.ts"),
      `export default { lexicons: ["k8s"], lint: { policies: ["policies/org.ts"] } };\n`,
    );

    const evaluation = await evaluateProjectPolicies({ path: testDir });

    expect(evaluation.warnings).toEqual([]);
  });
});
