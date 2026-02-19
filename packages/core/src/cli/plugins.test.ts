import { describe, test, expect } from "bun:test";
import { loadPlugin, loadPlugins } from "./plugins";
import { isLexiconPlugin } from "../lexicon";

describe("loadPlugin", () => {
  test("loads aws plugin with full LexiconPlugin interface", async () => {
    const plugin = await loadPlugin("aws");
    expect(isLexiconPlugin(plugin)).toBe(true);
    expect(plugin.name).toBe("aws");
    expect(plugin.serializer.name).toBe("aws");
    expect(typeof plugin.lintRules).toBe("function");
    expect(typeof plugin.detectTemplate).toBe("function");
  });

  test("throws for unknown lexicon package", async () => {
    await expect(loadPlugin("nonexistent")).rejects.toThrow();
  });
});

describe("loadPlugins", () => {
  test("loads multiple plugins", async () => {
    const plugins = await loadPlugins(["aws"]);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe("aws");
  });

  test("returns empty array for no serializers", async () => {
    const plugins = await loadPlugins([]);
    expect(plugins).toHaveLength(0);
  });
});
