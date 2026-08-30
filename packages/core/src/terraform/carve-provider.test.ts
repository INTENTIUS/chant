import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  carveEmitLexicons,
  carveProviders,
  registerCarveProvider,
  resolveCarveProvider,
  resolveEmitProvider,
  type CarveProvider,
} from "./carve-provider";
import { canBridge, canCarveEmit, carveEmitTypes, foldParentOf, identityAttrOf, resolveTier, tierMap } from "./tier-map";
import { adoptFromState } from "./adopt-state";

const fake: CarveProvider = {
  name: "test-fake",
  tfTypePrefixes: ["fake_"],
  lexicon: "fakelex",
  tiers: { fake_widget: { tier: 1, mapsTo: "fake:Widget" }, fake_gizmo: { tier: 3, mapsTo: "fake:Gizmo" } },
  identityAttrs: { fake_widget: "widget_name", fake_nested: "spec.metadata.name" },
  foldsInto: { fake_widget_setting: "fake_widget" },
  emitTypes: ["fake_widget"],
  adopt: (resource) => ({
    fileName: `${resource.name}.ts`,
    content: `// fake: ${resource.type}.${resource.name}\n`,
    mapped: true,
    nativeType: "fake:Widget",
    parameterized: [],
    folded: [],
  }),
  liveSelectorType: (tfType) => (tfType === "fake_widget" ? "fake:Widget" : undefined),
};

describe("carve provider registry (#2016)", () => {
  test("core ships aws, gcp and kubernetes; aws and kubernetes emit", () => {
    expect(carveProviders().map((p) => p.name)).toEqual(["aws", "gcp", "kubernetes"]);
    expect(carveEmitLexicons()).toEqual(["aws", "k8s"]);
    expect(resolveCarveProvider("aws_s3_bucket")?.name).toBe("aws");
    expect(resolveCarveProvider("google_storage_bucket")?.name).toBe("gcp");
    expect(resolveCarveProvider("kubernetes_config_map")?.name).toBe("kubernetes");
    expect(resolveCarveProvider("random_pet")).toBeUndefined();
  });

  test("a provider owns every type under its prefix for advise, only its emitTypes for emit", () => {
    // kubernetes ranks every typed provider resource and emits only
    // kubernetes_manifest; aws emits everything it ranks.
    expect(resolveCarveProvider("kubernetes_config_map")?.name).toBe("kubernetes");
    expect(resolveEmitProvider("kubernetes_config_map")).toBeUndefined();
    expect(resolveEmitProvider("kubernetes_manifest")?.name).toBe("kubernetes");
    expect(resolveEmitProvider("aws_s3_bucket")?.name).toBe("aws");
    // A type under aws_ that the carve table does not list is ranked by nobody
    // and emitted by nobody, but still resolves to the aws provider.
    expect(resolveCarveProvider("aws_glue_job")?.name).toBe("aws");
    expect(resolveEmitProvider("aws_glue_job")).toBeUndefined();
  });

  test("registering a provider widens advise, emit and bridge without touching them", () => {
    expect(resolveTier("fake_widget")).toBeNull();
    const dispose = registerCarveProvider(fake);
    try {
      // Tier map, identity, folds — all derived live from the registry.
      expect(resolveTier("fake_widget")).toEqual({ tier: 1, mapsTo: "fake:Widget" });
      expect(tierMap().fake_gizmo).toEqual({ tier: 3, mapsTo: "fake:Gizmo" });
      expect(identityAttrOf("fake_widget")).toBe("widget_name");
      expect(foldParentOf("fake_widget_setting")).toBe("fake_widget");
      // The bridge gate reads the same identity attrs: a dotted path is refused.
      expect(canBridge("fake_widget")).toBe(true);
      expect(canBridge("fake_nested")).toBe(false);
      // Emit gate + the user-facing type list.
      expect(canCarveEmit("fake_widget")).toBe(true);
      expect(canCarveEmit("fake_gizmo")).toBe(false);
      expect(carveEmitTypes()).toContain("fake_widget");
      expect(carveEmitLexicons()).toEqual(["aws", "fakelex", "k8s"]);
      // adopt-state dispatches to the provider, with no knowledge of it.
      const adopted = adoptFromState({ type: "fake_widget", name: "w", attributes: { widget_name: "w1" } });
      expect(adopted).toMatchObject({ fileName: "w.ts", nativeType: "fake:Widget" });
    } finally {
      dispose();
    }
    // Unregistering leaves the registry exactly as it was found.
    expect(resolveTier("fake_widget")).toBeNull();
    expect(carveEmitTypes()).not.toContain("fake_widget");
    expect(carveEmitLexicons()).toEqual(["aws", "k8s"]);
    expect(adoptFromState({ type: "fake_widget", name: "w", attributes: {} })).toBeNull();
  });

  test("the AWS entries are untouched by a second provider being present", () => {
    const before = carveEmitTypes().filter((t) => t.startsWith("aws_"));
    const dispose = registerCarveProvider(fake);
    try {
      expect(carveEmitTypes().filter((t) => t.startsWith("aws_"))).toEqual(before);
      expect(resolveTier("aws_s3_bucket")).toEqual({ tier: 1, mapsTo: "AWS::S3::Bucket" });
      expect(resolveEmitProvider("aws_s3_bucket")?.name).toBe("aws");
    } finally {
      dispose();
    }
  });

  test("the longest prefix wins, so a narrower provider can claim a subset", () => {
    const narrow: CarveProvider = {
      name: "test-narrow",
      tfTypePrefixes: ["fake_widget"],
      lexicon: "narrowlex",
      tiers: { fake_widget: { tier: 2, mapsTo: "narrow:Widget" } },
    };
    const disposeWide = registerCarveProvider(fake);
    const disposeNarrow = registerCarveProvider(narrow);
    try {
      expect(resolveCarveProvider("fake_widget")?.name).toBe("test-narrow");
      expect(resolveCarveProvider("fake_gizmo")?.name).toBe("test-fake");
    } finally {
      disposeNarrow();
      disposeWide();
    }
  });

  test("emitTypes without an adopter is refused — it would accept on --env and fail on --state", () => {
    expect(() =>
      registerCarveProvider({
        name: "test-no-adopt",
        tfTypePrefixes: ["broken_"],
        lexicon: "brokenlex",
        tiers: {},
        emitTypes: ["broken_thing"],
      }),
    ).toThrow(/emitTypes but no adopt/);
    expect(resolveCarveProvider("broken_thing")).toBeUndefined();
  });

  test("a provider claiming no prefix is refused — nothing would ever resolve to it", () => {
    expect(() =>
      registerCarveProvider({ name: "test-no-prefix", tfTypePrefixes: [], lexicon: "x", tiers: {} }),
    ).toThrow(/claims no Terraform type prefix/);
  });

  test("the seam pulls in no plugin loader and no lexicon package, so advise stays free", () => {
    // The reason the registry lives in core rather than behind a LexiconPlugin
    // capability: `carve advise` runs against a foreign Terraform tree with no
    // chant project to name lexicons, and `carve emit --state` is offline.
    // Either would become plugin-dependent if a provider module imported one.
    const root = join(import.meta.dirname, ".");
    const files = [
      ...readdirSync(root).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(root, f)),
      ...readdirSync(join(root, "providers")).map((f) => join(root, "providers", f)),
    ];
    expect(files.length).toBeGreaterThan(10); // not a vacuous pass
    const offenders: string[] = [];
    for (const file of files) {
      for (const [, spec] of readFileSync(file, "utf-8").matchAll(/\bfrom\s+"([^"]+)"/g)) {
        if (spec.includes("chant-lexicon-") || spec.includes("cli/plugins")) offenders.push(`${file}: ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
