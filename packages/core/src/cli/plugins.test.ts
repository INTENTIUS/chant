import { describe, test, expect } from "vitest";
import { loadPlugin, loadPlugins, resolveLexiconVersions } from "./plugins";
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

/**
 * chant #1442 — the installed version of each lexicon package, read for the
 * build digest.
 */
describe("resolveLexiconVersions", () => {
  test("reads the real installed version of a workspace lexicon", () => {
    const versions = resolveLexiconVersions(["k8s"]);
    expect(versions.k8s).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("resolves several lexicons in one call", () => {
    const versions = resolveLexiconVersions(["k8s", "aws"]);
    expect(Object.keys(versions).sort()).toEqual(["aws", "k8s"]);
  });

  test("omits a lexicon that is not installed rather than inventing a version", () => {
    // "unknown" would compare unequal to itself across builds and report a
    // version change on every diff.
    expect(resolveLexiconVersions(["definitely-not-a-lexicon"])).toEqual({});
  });

  test("an unresolvable name does not prevent the resolvable ones", () => {
    const versions = resolveLexiconVersions(["definitely-not-a-lexicon", "k8s"]);
    expect(versions.k8s).toBeDefined();
    expect(versions["definitely-not-a-lexicon"]).toBeUndefined();
  });

  test("no names yields an empty map", () => {
    expect(resolveLexiconVersions([])).toEqual({});
  });
});
