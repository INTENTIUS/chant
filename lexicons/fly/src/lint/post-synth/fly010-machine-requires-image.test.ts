import { describe, test, expect } from "vitest";
import type { Declarable } from "@intentius/chant";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { fly010 } from "./fly010-machine-requires-image";
import { App, Machine, MachineConfig } from "../../generated/index";

function ctx(...entries: Array<[string, unknown]>): PostSynthContext {
  const entities = new Map(entries as Array<[string, Declarable]>);
  return {
    outputs: new Map(),
    entities,
    buildResult: { outputs: new Map(), entities, warnings: [], errors: [], sourceFileCount: 1 },
  };
}

describe("FLY010: machine config requires an image", () => {
  test("flags a machine whose config sets no image", () => {
    const diags = fly010.check(
      ctx(["web", new Machine({ config: new MachineConfig({ env: { PORT: "8080" } }) })]),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("FLY010");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("web");
  });

  test("passes a machine whose config sets an image (MachineConfig instance)", () => {
    // The instance form nests its args under `.props`; the check must unwrap it
    // rather than false-flagging a machine that does have an image.
    const diags = fly010.check(
      ctx(["web", new Machine({ config: new MachineConfig({ image: "nginx" }) })]),
    );
    expect(diags).toHaveLength(0);
  });

  test("passes a machine whose config sets an image (plain inline object)", () => {
    const diags = fly010.check(
      ctx([
        "web",
        new Machine({ config: { image: "flyio/hellofly:latest" } as unknown as MachineConfig }),
      ]),
    );
    expect(diags).toHaveLength(0);
  });

  test("ignores non-machine entities and machines with no config", () => {
    const diags = fly010.check(
      ctx(
        ["app", new App({ name: "my-app" })],
        ["bare", new Machine({ name: "bare" })],
      ),
    );
    expect(diags).toHaveLength(0);
  });

  test("has the expected id", () => {
    expect(fly010.id).toBe("FLY010");
  });
});
