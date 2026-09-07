import { describe, test, expect } from "vitest";
import { collectChangeSubscribers, loadPlugin, loadPlugins, resolveLexiconVersions } from "./plugins";
import { isLexiconPlugin, type LexiconPlugin } from "../lexicon";

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

describe("collectChangeSubscribers (#1981)", () => {
  function fakePlugin(name: string, withSeam: boolean): LexiconPlugin {
    const plugin = {
      name,
      serializer: { name, serialize: () => "" },
      generate: async () => {},
      validate: async () => {},
      coverage: async () => {},
      package: async () => {},
    } as unknown as LexiconPlugin;
    if (withSeam) {
      plugin.subscribeChanges = async () => ({ close: async () => {} });
    }
    return plugin;
  }

  const entitiesFor = (lexicon: string) =>
    new Map([[lexicon, new Map([["web", { entityType: "K8s::Apps::Deployment", props: {} }]])]]);

  test("a lexicon without the seam contributes nothing", () => {
    expect(
      collectChangeSubscribers([fakePlugin("aws", false)], {
        environment: "prod",
        entities: entitiesFor("aws"),
      }),
    ).toEqual([]);
  });

  test("a lexicon with the seam but no declared entities is skipped rather than handed an empty scope", () => {
    expect(
      collectChangeSubscribers([fakePlugin("k8s", true)], {
        environment: "prod",
        entities: new Map(),
      }),
    ).toEqual([]);
  });

  test("binds the environment, cwd and this lexicon's own entity slice", async () => {
    const plugin = fakePlugin("k8s", true);
    let seen: Record<string, unknown> | undefined;
    plugin.subscribeChanges = async (options) => {
      seen = options as unknown as Record<string, unknown>;
      return { close: async () => {} };
    };

    const entities = new Map([
      ["k8s", new Map([["web", { entityType: "K8s::Apps::Deployment", props: {} }]])],
      ["aws", new Map([["bucket", { entityType: "AWS::S3::Bucket", props: {} }]])],
    ]);
    const subscribers = collectChangeSubscribers([plugin], { environment: "prod", cwd: "/proj", entities });
    expect(subscribers).toHaveLength(1);
    expect(subscribers[0].lexicon).toBe("k8s");

    const controller = new AbortController();
    const onChange = () => {};
    const onError = () => {};
    await subscribers[0].subscribe({ onChange, onError, signal: controller.signal });
    expect(seen!.environment).toBe("prod");
    expect(seen!.cwd).toBe("/proj");
    expect(seen!.onChange).toBe(onChange);
    expect(seen!.signal).toBe(controller.signal);
    // This lexicon's slice only: aws's bucket is not in scope for k8s.
    expect([...(seen!.entities as Map<string, unknown>).keys()]).toEqual(["web"]);
  });
});
