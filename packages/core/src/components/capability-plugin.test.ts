/**
 * Tests for the Phase 2 capability plugin contract (#559, epic #551):
 * `isCapabilityPlugin` (./capability-plugin.ts), manifest validation
 * (./capability-plugin-schema.ts), and plugin loading/registration/registry
 * building (./capability-plugin-loader.ts) — mirroring how
 * ../lexicon.test-equivalent coverage (../cli/plugins.test.ts,
 * ../lexicon-schema.test.ts) validates the lexicon plugin contract.
 */

import { describe, expect, test } from "vitest";
import { isCapabilityPlugin, type CapabilityPlugin } from "./capability-plugin";
import { validateCapabilityManifest, CapabilityManifestSchema } from "./capability-plugin-schema";
import {
  loadCapabilityPlugin,
  loadCapabilityPluginFromLexicon,
  loadCapabilityPluginsFromLexicons,
  registerCapabilityPlugins,
  buildCapabilityRegistry,
  MalformedCapabilityPluginError,
  DuplicateCapabilityKindError,
} from "./capability-plugin-loader";
import { CapabilityRegistry } from "./capability";
import { STARTER_VERB_FAMILIES } from "./registry";
import { starterCapabilityPlugin } from "./starter-plugin";

const ALL_STARTER_KINDS = Object.values(STARTER_VERB_FAMILIES).flat();

// A trivial well-formed plugin used across several tests below.
function fakePlugin(name: string, kinds: string[]): CapabilityPlugin {
  return {
    name,
    version: "1.0.0",
    capabilities: () => kinds.map((kind) => ({ kind, run: async () => ({}) })),
  };
}

describe("isCapabilityPlugin", () => {
  test("accepts a well-formed plugin", () => {
    expect(isCapabilityPlugin(fakePlugin("demo", ["demo-verb"]))).toBe(true);
  });

  test("accepts the real starter plugin", () => {
    expect(isCapabilityPlugin(starterCapabilityPlugin)).toBe(true);
  });

  test("rejects null/non-object", () => {
    expect(isCapabilityPlugin(null)).toBe(false);
    expect(isCapabilityPlugin(undefined)).toBe(false);
    expect(isCapabilityPlugin("a string")).toBe(false);
    expect(isCapabilityPlugin(42)).toBe(false);
  });

  test("rejects a value missing name", () => {
    expect(isCapabilityPlugin({ version: "1.0.0", capabilities: () => [] })).toBe(false);
  });

  test("rejects a value missing version", () => {
    expect(isCapabilityPlugin({ name: "demo", capabilities: () => [] })).toBe(false);
  });

  test("rejects a value whose capabilities is not a function (malformed package)", () => {
    expect(isCapabilityPlugin({ name: "demo", version: "1.0.0", capabilities: [] })).toBe(false);
  });

  test("rejects a value with no capabilities field at all (malformed package)", () => {
    expect(isCapabilityPlugin({ name: "demo", version: "1.0.0" })).toBe(false);
  });

  test("rejects a value whose name/version are the wrong type", () => {
    expect(isCapabilityPlugin({ name: 123, version: "1.0.0", capabilities: () => [] })).toBe(false);
    expect(isCapabilityPlugin({ name: "demo", version: 1, capabilities: () => [] })).toBe(false);
  });
});

describe("validateCapabilityManifest", () => {
  test("parses a valid manifest object", () => {
    const m = validateCapabilityManifest({
      name: "aws",
      version: "1.0.0",
      chantVersion: ">=0.1.0",
      kinds: ["cfn-deploy", "ecs-update-service"],
    });
    expect(m.name).toBe("aws");
    expect(m.version).toBe("1.0.0");
    expect(m.chantVersion).toBe(">=0.1.0");
    expect(m.kinds).toEqual(["cfn-deploy", "ecs-update-service"]);
  });

  test("parses a valid JSON string", () => {
    const m = validateCapabilityManifest(JSON.stringify({ name: "gcp", version: "0.1.0" }));
    expect(m.name).toBe("gcp");
    expect(m.version).toBe("0.1.0");
  });

  test("optional fields can be omitted", () => {
    const m = validateCapabilityManifest({ name: "gcp", version: "2.0.0" });
    expect(m.chantVersion).toBeUndefined();
    expect(m.kinds).toBeUndefined();
  });

  test("rejects empty input", () => {
    expect(() => validateCapabilityManifest(null)).toThrow(/empty/);
    expect(() => validateCapabilityManifest(undefined)).toThrow(/empty/);
  });

  test("rejects invalid JSON string (malformed package manifest)", () => {
    expect(() => validateCapabilityManifest("not valid json{{{")).toThrow(/invalid JSON/);
  });

  test("rejects a non-object (malformed package manifest)", () => {
    expect(() => validateCapabilityManifest("just a string")).toThrow(/invalid JSON|must be a JSON object/);
    expect(() => validateCapabilityManifest(["array", "not", "object"])).toThrow(/must be a JSON object/);
  });

  test("rejects a manifest missing name", () => {
    expect(() => validateCapabilityManifest({ version: "1.0.0" })).toThrow(/name/);
  });

  test("rejects a manifest with an empty name", () => {
    expect(() => validateCapabilityManifest({ name: "", version: "1.0.0" })).toThrow(/must not be empty/);
  });

  test("rejects a manifest with a non-semver version (malformed package)", () => {
    expect(() => validateCapabilityManifest({ name: "aws", version: "not-a-version" })).toThrow(/semver/);
  });

  test("rejects a manifest with an empty kind entry", () => {
    const result = CapabilityManifestSchema.safeParse({ name: "aws", version: "1.0.0", kinds: [""] });
    expect(result.success).toBe(false);
  });
});

describe("loadCapabilityPlugin", () => {
  test("throws a descriptive error for a package that cannot be found", async () => {
    await expect(loadCapabilityPlugin("nonexistent-does-not-exist")).rejects.toThrow(
      /could not be loaded/,
    );
  });
});

describe("registerCapabilityPlugins", () => {
  test("registers every capability every plugin contributes", () => {
    const registry = new CapabilityRegistry();
    registerCapabilityPlugins(registry, [fakePlugin("demo-a", ["verb-a", "verb-b"]), fakePlugin("demo-b", ["verb-c"])]);
    expect(registry.has("verb-a")).toBe(true);
    expect(registry.has("verb-b")).toBe(true);
    expect(registry.has("verb-c")).toBe(true);
  });

  test("throws DuplicateCapabilityKindError when two plugins register the same kind (malformed/conflicting package set)", () => {
    const registry = new CapabilityRegistry();
    expect(() =>
      registerCapabilityPlugins(registry, [fakePlugin("demo-a", ["shared-verb"]), fakePlugin("demo-b", ["shared-verb"])]),
    ).toThrow(DuplicateCapabilityKindError);
  });

  test("DuplicateCapabilityKindError names every offending plugin", () => {
    const registry = new CapabilityRegistry();
    try {
      registerCapabilityPlugins(registry, [fakePlugin("demo-a", ["shared-verb"]), fakePlugin("demo-b", ["shared-verb"])]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DuplicateCapabilityKindError);
      const dup = err as DuplicateCapabilityKindError;
      expect(dup.kind).toBe("shared-verb");
      expect(dup.plugins).toEqual(["demo-a", "demo-b"]);
    }
  });

  test("a duplicate-kind conflict leaves the registry unmodified (all-or-nothing)", () => {
    const registry = new CapabilityRegistry();
    try {
      registerCapabilityPlugins(registry, [fakePlugin("demo-a", ["shared-verb"]), fakePlugin("demo-b", ["shared-verb"])]);
    } catch {
      /* expected */
    }
    expect(registry.has("shared-verb")).toBe(false);
  });
});

describe("buildCapabilityRegistry (Phase 2 entry point)", () => {
  test("preserves every Phase 1 starter kind with no behavior change", async () => {
    const registry = await buildCapabilityRegistry();
    for (const kind of ALL_STARTER_KINDS) {
      expect(registry.has(kind)).toBe(true);
    }
    expect(registry.kinds()).toEqual([...ALL_STARTER_KINDS].sort());
  });

  test("layers an explicitly-provided plugin on top of the starter set", async () => {
    // buildCapabilityRegistry's `plugins` option loads packages by name via
    // loadCapabilityPlugin; exercise the registration/layering behavior
    // directly through registerCapabilityPlugins + the starter plugin,
    // since a real third-party package isn't installed in this repo.
    const registry = new CapabilityRegistry();
    registerCapabilityPlugins(registry, [starterCapabilityPlugin, fakePlugin("acme", ["acme-verb"])]);
    for (const kind of ALL_STARTER_KINDS) {
      expect(registry.has(kind)).toBe(true);
    }
    expect(registry.has("acme-verb")).toBe(true);
  });

  test("includeStarter: false omits the starter plugin", async () => {
    const registry = await buildCapabilityRegistry({ includeStarter: false, plugins: [] });
    expect(registry.kinds()).toEqual([]);
  });

  test("a lexicon that contributes no capability plugin is silently skipped (starter set intact)", async () => {
    // `loadCapabilityPluginsFromLexicons` is tolerant: an unresolvable or
    // capability-less lexicon contributes nothing rather than throwing, unlike
    // the strict `@intentius/chant-capability-<name>` path.
    const registry = await buildCapabilityRegistry({ lexicons: ["definitely-not-a-real-lexicon"] });
    expect(registry.kinds()).toEqual([...ALL_STARTER_KINDS].sort());
  });
});

describe("loadCapabilityPluginFromLexicon", () => {
  test("returns null for a lexicon package that cannot be resolved", async () => {
    expect(await loadCapabilityPluginFromLexicon("definitely-not-a-real-lexicon")).toBeNull();
  });

  test("loadCapabilityPluginsFromLexicons skips unresolvable lexicons without throwing", async () => {
    expect(await loadCapabilityPluginsFromLexicons(["definitely-not-a-real-lexicon"])).toEqual([]);
  });
});

describe("MalformedCapabilityPluginError", () => {
  test("carries the offending package name and a descriptive message", () => {
    const err = new MalformedCapabilityPluginError("@intentius/chant-capability-broken", "no capabilities() export");
    expect(err.packageName).toBe("@intentius/chant-capability-broken");
    expect(err.message).toContain("@intentius/chant-capability-broken");
    expect(err.message).toContain("no capabilities() export");
    expect(err.name).toBe("MalformedCapabilityPluginError");
  });
});

// #1505 — plugin versions track the lockstep release instead of a literal that
// goes stale on every `just release` (aws shipped "1.0.0" from its extraction;
// the k8s plugin's authoring-time literal was stale one release later).
describe("ownPackageVersion (#1505)", () => {
  test("resolves this module's own package version — core's package.json, exactly", async () => {
    const { ownPackageVersion } = await import("./capability-plugin");
    const { readFileSync } = await import("node:fs");
    const { version } = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as { version: string };
    expect(ownPackageVersion(import.meta.url)).toBe(version);
  });

  test("the starter plugin reports that version, not a literal", async () => {
    const { starterCapabilityPlugin } = await import("./starter-plugin");
    const { ownPackageVersion } = await import("./capability-plugin");
    expect(starterCapabilityPlugin.version).toBe(ownPackageVersion(import.meta.url));
    expect(starterCapabilityPlugin.version).not.toBe("1.0.0");
  });
});
