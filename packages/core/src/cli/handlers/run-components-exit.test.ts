/**
 * `chant run --components` exits 3 when a step refuses a plan that moved
 * since it was approved (#3997), on the single-component path and on the
 * driver's `all` and list paths. Discovery and the capability registry are
 * fakes; the run is the real `runComponents` on the local runtime.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Component } from "../../components/component";
import type { ParsedArgs } from "../registry";

const discoverComponentsMock = vi.fn();
vi.mock("../../components/discover", () => ({
  discoverComponents: (...args: unknown[]) => discoverComponentsMock(...args),
}));

vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: async () => ({ config: {} }) };
});

/** The error a component's step throws, in place of applying. */
const refusal = new Map<string, Error>();

vi.mock("../../op/runtimes/local", async () => {
  const { CapabilityRegistry } = await import("../../components/capability");
  const { runComponents } = await import("../../components/cli-support");
  const { memoryGateLedgerPort } = await import("../../op/gate");
  const registry = new CapabilityRegistry();
  registry.register({
    kind: "fake-apply",
    async run(ctx: { component: string }) {
      const err = refusal.get(ctx.component);
      if (err) throw err;
      return {};
    },
  } as never);
  return {
    createLocalOpRuntime: () => ({
      name: "local",
      runComponents: (path: string, selector: string, options: object) =>
        runComponents(path, selector, { ...options, registry, config: {}, revision: null, gates: memoryGateLedgerPort() }),
    }),
  };
});

const { runOpComponents } = await import("./run");

const component = (name: string, dependsOn: string[] = []): Component => ({
  name,
  dependsOn,
  deploy: [{ phase: "Apply", steps: [{ kind: "fake-apply" }] }],
});

const ctx = (selector: string) =>
  ({
    args: { command: "run", path: selector, components: true, on: "local", format: "", fix: false, watch: false, verbose: false, help: false, live: false } as ParsedArgs,
    plugins: [],
  }) as never;

beforeEach(() => {
  refusal.clear();
  const estate = [component("net"), component("app", ["net"])];
  discoverComponentsMock.mockResolvedValue({
    components: new Map(estate.map((c) => [c.name, { component: c, exportName: c.name, filePath: `${c.name}.component.ts` }])),
    sourceFiles: [],
    errors: [],
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const marks: Array<[string, number, object]> = [
  ["marked planMoved", 3, { planMoved: true }],
  ["with exitCode 3", 3, { exitCode: 3 }],
  ["with exitCode 7", 1, { exitCode: 7 }],
  ["unmarked", 1, {}],
];

describe("chant run --components: a step that refuses a moved plan exits 3 (#3997)", () => {
  test.each(marks)("one component, its step refusing %s: exit %i", async (_label, code, mark) => {
    refusal.set("app", Object.assign(new Error("app: refusing to apply, the plan moved"), mark));
    expect(await runOpComponents(ctx("app"))).toBe(code);
  });

  test.each(marks)("all, a step refusing %s: exit %i", async (_label, code, mark) => {
    refusal.set("net", Object.assign(new Error("net: refusing to apply, the plan moved"), mark));
    expect(await runOpComponents(ctx("all"))).toBe(code);
  });

  test("a list that pulls in a dependency whose step refuses a moved plan exits 3", async () => {
    refusal.set("net", Object.assign(new Error("net: refusing to apply, the plan moved"), { planMoved: true }));
    expect(await runOpComponents(ctx("app,net"))).toBe(3);
  });
});
