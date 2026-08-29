/**
 * chant #2002 — the shared build-option assembler. `chant build` and the
 * `policyGate` step both call this; `../lint/policy-build-parity.test.ts`
 * proves they stay in step, this file pins what the function itself resolves.
 */
import { describe, test, expect } from "vitest";
import { createMockPlugin } from "@intentius/chant-test-utils";
import type { LexiconPlugin } from "../lexicon";
import type { ChantConfig } from "../config";
import { resolveBuildModes, resolveProjectBuildOptions } from "./build-options";

const config = (over: Record<string, unknown> = {}): ChantConfig => over as ChantConfig;

describe("resolveBuildModes", () => {
  test("fold defaults on, sandbox defaults off (#1134 / #1045)", () => {
    expect(resolveBuildModes(config())).toEqual({ fold: true, sandbox: false });
  });

  test("the project config decides when no flag is given", () => {
    expect(resolveBuildModes(config({ build: { fold: false, sandbox: true } })))
      .toEqual({ fold: false, sandbox: true });
  });

  test("an explicit flag wins over the config, in both directions", () => {
    expect(resolveBuildModes(config({ build: { fold: false } }), { fold: true }).fold).toBe(true);
    expect(resolveBuildModes(config({ build: { fold: true } }), { fold: false }).fold).toBe(false);
    expect(resolveBuildModes(config(), { sandbox: true }).sandbox).toBe(true);
  });
});

describe("resolveProjectBuildOptions", () => {
  const modes = { fold: true, sandbox: false };

  test("threads the project config through to the serializers", () => {
    const projectConfig = config({ forgejo: { runnerLabels: { "ubuntu-latest": "docker-arm" } } });
    const options = resolveProjectBuildOptions({ config: projectConfig, configDir: "/p", modes });
    expect(options.config).toEqual(projectConfig);
  });

  test("collects intrinsics and lexicon names from the loaded plugins", () => {
    const intrinsic = { tag: "Sub", lexicon: "aws" } as never;
    const plugins: LexiconPlugin[] = [
      { ...createMockPlugin({ name: "aws" }), intrinsics: () => [intrinsic] },
      createMockPlugin({ name: "k8s" }),
    ];
    const options = resolveProjectBuildOptions({ config: config(), configDir: "/p", plugins, modes });
    expect(options.lexicons).toEqual(["aws", "k8s"]);
    expect(options.intrinsics).toEqual([intrinsic]);
  });

  test("binds each plugin's buildRoots hook to the CONFIG dir, not the build path", async () => {
    let seenRoot: string | undefined;
    const plugins: LexiconPlugin[] = [
      {
        ...createMockPlugin({ name: "cedar" }),
        buildRoots: async (ctx) => {
          seenRoot = ctx.projectRoot;
          return { entities: new Map() };
        },
      },
    ];
    const options = resolveProjectBuildOptions({ config: config(), configDir: "/project", plugins, modes });
    expect(options.buildRoots).toHaveLength(1);
    await options.buildRoots![0]({ entities: new Map() });
    expect(seenRoot).toBe("/project");
  });

  test("a plugin without a buildRoots hook contributes nothing", () => {
    const options = resolveProjectBuildOptions({
      config: config(),
      configDir: "/p",
      plugins: [createMockPlugin({ name: "k8s" })],
      modes,
    });
    expect(options.buildRoots).toEqual([]);
  });

  test("no plugins at all is empty, never undefined-by-accident", () => {
    const options = resolveProjectBuildOptions({ config: config(), configDir: "/p", modes });
    expect(options.lexicons).toEqual([]);
    expect(options.intrinsics).toEqual([]);
    expect(options.buildRoots).toEqual([]);
    expect(options.lexiconVersions).toEqual({});
  });

  test("carries the resolved modes, ownership and build parameters verbatim", () => {
    const ownership = { stack: "s", env: "prod" } as never;
    const buildParams = [{ name: "env", value: "prod", source: "default" }] as never;
    const options = resolveProjectBuildOptions({
      config: config(),
      configDir: "/p",
      modes: { fold: false, sandbox: true },
      ownership,
      buildParams,
    });
    expect(options.fold).toBe(false);
    expect(options.sandbox).toBe(true);
    expect(options.ownership).toBe(ownership);
    expect(options.buildParams).toBe(buildParams);
  });
});
