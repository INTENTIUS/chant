import { describe, test, expect } from "vitest";
import type { Declarable } from "@intentius/chant";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { fly011 } from "./fly011-mount-references-declared-volume";
import { App, Machine, MachineConfig, MachineMount, Volume } from "../../generated/index";

/**
 * Build a whole-stack PostSynthContext from entities keyed by logical name.
 * FLY011 only reads `ctx.entities`, so the rest of the context is minimal.
 */
function ctx(...entries: Array<[string, unknown]>): PostSynthContext {
  const entities = new Map(entries as Array<[string, Declarable]>);
  return {
    outputs: new Map(),
    entities,
    buildResult: { outputs: new Map(), entities, warnings: [], errors: [], sourceFileCount: 1 },
  };
}

describe("FLY011: mount references a declared volume", () => {
  test("flags a machine mounting a volume declared nowhere in the stack", () => {
    // Volume and machine are separate stack entities — the cross-file case.
    const diags = fly011.check(
      ctx(
        ["app", new App({ name: "my-app" })],
        ["data", new Volume({ name: "data", region: "iad", size_gb: 10 })],
        [
          "web",
          new Machine({
            config: new MachineConfig({
              image: "nginx",
              mounts: [new MachineMount({ volume: "cache", path: "/data" })],
            }),
          }),
        ],
      ),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("FLY011");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("web");
    expect(diags[0].message).toContain("cache");
  });

  test("passes when the mount names a Volume declared in the stack", () => {
    const diags = fly011.check(
      ctx(
        ["data", new Volume({ name: "data", region: "iad", size_gb: 10 })],
        [
          "web",
          new Machine({
            config: new MachineConfig({
              image: "nginx",
              mounts: [new MachineMount({ volume: "data", path: "/data" })],
            }),
          }),
        ],
      ),
    );
    expect(diags).toHaveLength(0);
  });

  test("resolves a volume by its logical (declaration) name too", () => {
    const diags = fly011.check(
      ctx(
        // No explicit `name` prop; the mount references the logical name.
        ["cache", new Volume({ region: "iad", size_gb: 3 })],
        [
          "web",
          new Machine({
            config: new MachineConfig({
              image: "nginx",
              mounts: [new MachineMount({ volume: "cache", path: "/data" })],
            }),
          }),
        ],
      ),
    );
    expect(diags).toHaveLength(0);
  });

  test("does not flag a machine without mounts", () => {
    const diags = fly011.check(
      ctx(["web", new Machine({ config: new MachineConfig({ image: "nginx" }) })]),
    );
    expect(diags).toHaveLength(0);
  });

  test("has the expected id", () => {
    expect(fly011.id).toBe("FLY011");
  });
});
