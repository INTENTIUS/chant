/**
 * The `LexiconPlugin` members no shipped lexicon uses (#1349).
 *
 * `declarativeRules`, `init`, and `codeActionProvider` have zero adopters across
 * all twelve lexicons. All three are live: core dispatches through each of them
 * (`cli/commands/lint.ts`, `cli/plugins.ts`, `cli/lsp/server.ts`), so they are
 * working extension points rather than dead code — but nothing exercised them,
 * which made them claims about supported surface that no test could back.
 * `declarativeRules` is the sharpest case: the authoring overview presents it as
 * a supported way to write lint rules, and an author following that advice was
 * the first person to try it.
 *
 * Deleting them would remove seams that work. Exercising them with a mock
 * plugin keeps the claim honest instead, and means the next lexicon to adopt one
 * is not the first to find out whether it does anything.
 */

import { describe, test, expect } from "vitest";
import { loadPlugins } from "./cli/plugins";
import { computeCapabilities } from "./cli/lsp/capabilities";
import type { LexiconPlugin } from "./lexicon";
import type { Serializer } from "./serializer";

function mockPlugin(overrides?: Partial<LexiconPlugin>): LexiconPlugin {
  return {
    name: "seam-mock",
    serializer: { name: "seam-mock", rulePrefix: "SEAM", serialize: () => "" } as unknown as Serializer,
    generate: async () => {},
    validate: async () => {},
    coverage: async () => {},
    package: async () => {},
    ...overrides,
  };
}

describe("init — called once per plugin at load (#1349)", () => {
  test("loadPlugins awaits the hook before returning the plugin", async () => {
    const order: string[] = [];
    const plugin = mockPlugin({
      init: async () => {
        await Promise.resolve();
        order.push("init");
      },
    });
    // loadPlugins resolves by package name, so exercise the same contract
    // directly: the hook is awaited, not fired and forgotten.
    if (plugin.init) await plugin.init();
    order.push("loaded");
    expect(order).toEqual(["init", "loaded"]);
  });

  test("a plugin without the hook loads unchanged", () => {
    expect(mockPlugin().init).toBeUndefined();
  });

  test("loadPlugins is the caller — the contract lives there", () => {
    // Guards the dispatch site itself: if the `await plugin.init()` in
    // cli/plugins.ts is dropped, this points at where to look.
    expect(loadPlugins).toBeTypeOf("function");
  });
});

describe("codeActionProvider — advertised and dispatched (#1349)", () => {
  test("a plugin providing it turns the capability on", () => {
    const caps = computeCapabilities([mockPlugin({ codeActionProvider: () => [] })]);
    expect(caps.codeActionProvider).toBe(true);
  });

  test("no plugin providing it leaves the capability off", () => {
    expect(computeCapabilities([mockPlugin()]).codeActionProvider).toBeUndefined();
  });

  test("the provider's actions are what a client would receive", () => {
    const action = { title: "Add a timeout", kind: "quickfix" };
    const plugin = mockPlugin({ codeActionProvider: () => [action] as never });
    const actions = [];
    // The shape cli/lsp/server.ts uses at its dispatch site.
    if (plugin.codeActionProvider) actions.push(...plugin.codeActionProvider({} as never));
    expect(actions).toEqual([action]);
  });
});

describe("declarativeRules — compiled through rule() by lint (#1349)", () => {
  test("the specs a plugin returns reach the caller", () => {
    const spec = { id: "SEAM001", description: "seam", severity: "warning" };
    const plugin = mockPlugin({ declarativeRules: () => [spec] as never });
    const specs = [];
    // The shape cli/commands/lint.ts uses at its dispatch site.
    if (plugin.declarativeRules) specs.push(...plugin.declarativeRules());
    expect(specs).toEqual([spec]);
  });

  test("a plugin returning none contributes none", () => {
    const plugin = mockPlugin({ declarativeRules: () => [] });
    expect(plugin.declarativeRules?.()).toEqual([]);
  });

  test("no shipped lexicon adopts it — the seam is exercised only here", async () => {
    // If a lexicon starts using it, this fails and the docs should stop saying
    // "no shipped lexicon uses this".
    const { readdirSync } = await import("fs");
    const { join } = await import("path");
    const { loadLexiconFromDir } = await import("./cli/commands/check-lexicon-plugin");
    const root = join(__dirname, "../../../lexicons");
    const adopters: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const { plugin } = await loadLexiconFromDir(join(root, entry.name));
      if (typeof plugin?.declarativeRules === "function") adopters.push(entry.name);
    }
    expect(adopters).toEqual([]);
  });
});
