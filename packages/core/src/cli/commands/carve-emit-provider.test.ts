import { describe, test, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { carveEmit, formatCarveEmit } from "./carve-emit";
import { loadHcl2json } from "../../terraform/parse";
import { registerCarveProvider, type CarveProvider } from "../../terraform/carve-provider";
import type { ImportResult, LiveImportOptions } from "./import";
import type { LexiconPlugin } from "../../lexicon";

/**
 * The carve provider seam (#2016), driven end to end by a provider core has
 * never heard of. Nothing in `carve-emit.ts` or `adopt-state.ts` mentions
 * `fake_`, `fakelex` or `fake:Widget` — if emit can carry this estate to
 * emitted source, a scaffolded project and a live selector, then adding a real
 * provider (#999 kubernetes, #2017 gcp) is a file under `terraform/providers/`.
 */
let parserAvailable = false;
try {
  await loadHcl2json();
  parserAvailable = true;
} catch {
  parserAvailable = false;
}

const ESTATE = `
resource "fake_widget" "hero" { widget_name = "hero-widget" }
resource "fake_widget_setting" "hero" {
  widget = fake_widget.hero.id
  colour = "blue"
}
resource "fake_consumer" "reader" { widget = fake_widget.hero.id }
resource "fake_gizmo" "spare" { size = 3 }
`;

const TFSTATE = JSON.stringify({
  version: 4,
  resources: [
    {
      mode: "managed",
      type: "fake_widget",
      name: "hero",
      instances: [{ attributes: { id: "hero-widget", widget_name: "hero-widget" } }],
    },
    {
      mode: "managed",
      type: "fake_widget_setting",
      name: "hero",
      instances: [{ attributes: { id: "hero-widget", colour: "blue" } }],
    },
  ],
});

/** A provider with an emit path: adopt from state, and a live selector type. */
const fakeProvider: CarveProvider = {
  name: "test-fake-emit",
  tfTypePrefixes: ["fake_"],
  lexicon: "fakelex",
  tiers: {
    fake_widget: { tier: 1, mapsTo: "fake:Widget" },
    fake_widget_setting: { tier: 2, mapsTo: "fake:WidgetSetting" },
    fake_gizmo: { tier: 2, mapsTo: "fake:Gizmo" },
  },
  identityAttrs: { fake_widget: "widget_name" },
  foldsInto: { fake_widget_setting: "fake_widget" },
  emitTypes: ["fake_widget"],
  adopt: (resource, params, folded) => ({
    fileName: `${resource.name}.widget.ts`,
    content: `// fake provider adopted ${resource.type}.${resource.name}\nexport const ${resource.name} = "${resource.attributes.widget_name}";\n`,
    mapped: true,
    nativeType: "fake:Widget",
    parameterized: params.map((p) => p.name),
    folded: folded.map((f) => ({ address: `${f.type}.${f.name}`, props: ["Colour"] })),
  }),
  liveSelectorType: (tfType) => (tfType === "fake_widget" ? "fake:Widget" : undefined),
};

/** Same provider, state-only: no live adoption path at all. */
const stateOnlyProvider: CarveProvider = {
  ...fakeProvider,
  name: "test-fake-state-only",
  liveSelectorType: undefined,
};

const fakeImport = () =>
  vi.fn(
    async (_plugins: LexiconPlugin[], _options: LiveImportOptions): Promise<ImportResult> => ({
      success: true,
      generatedFiles: ["infra/hero.ts"],
      warnings: [],
    }),
  );

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

async function withEstate<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chant-carve-provider-"));
  try {
    writeFileSync(join(dir, "main.tf"), ESTATE);
    writeFileSync(join(dir, "terraform.tfstate"), TFSTATE);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("carve emit through a registered provider (#2016)", () => {
  test("without a provider the type is unknown to advise and refused by emit", async () => {
    if (!parserAvailable) return;
    await withEstate(async (dir) => {
      const res = await carveEmit(
        { from: dir, select: "fake_widget.hero", statePath: join(dir, "terraform.tfstate") },
        { plugins: [], liveImport: fakeImport() },
      );
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/no known native mapping/i);
    });
  });

  test("--state emits through the provider and scaffolds for its lexicon", async () => {
    if (!parserAvailable) return;
    dispose = registerCarveProvider(fakeProvider);
    await withEstate(async (dir) => {
      const out = join(dir, "carveout");
      const liveImport = fakeImport();
      const res = await carveEmit(
        { from: dir, select: "fake_widget.hero", statePath: join(dir, "terraform.tfstate"), output: out },
        { plugins: [], liveImport },
      );

      expect(res.ok).toBe(true);
      expect(res.source).toBe("tfstate");
      expect(liveImport).not.toHaveBeenCalled();

      // The provider named the file and wrote the content; core wrote it out.
      expect(res.emittedFiles).toEqual([join(out, "src", "hero.widget.ts")]);
      expect(readFileSync(res.emittedFiles![0], "utf-8")).toContain("fake provider adopted fake_widget.hero");

      // The scaffold targets the provider's lexicon, not a hardcoded aws.
      const pkg = JSON.parse(readFileSync(join(out, "package.json"), "utf-8"));
      expect(pkg.scripts.build).toBe("chant build src --lexicon fakelex");
      expect(Object.keys(pkg.dependencies)).toEqual(["@intentius/chant", "@intentius/chant-lexicon-fakelex"]);
      expect(readFileSync(join(out, "chant.config.ts"), "utf-8")).toContain('lexicons: ["fakelex"]');

      // The provider's foldsInto drove the carve set, so the setting folded in.
      expect(res.folded).toEqual([{ address: "fake_widget_setting.hero", props: ["Colour"] }]);
      expect(formatCarveEmit(res)).toContain("fake_widget_setting.hero (Colour)");
      // And its identityAttrs gave the graph the physical name.
      expect(res.report!.inbound.map((e) => e.survivor)).toEqual(["fake_consumer.reader"]);
    });
  });

  test("--env uses the provider's live selector type and lexicon", async () => {
    if (!parserAvailable) return;
    dispose = registerCarveProvider(fakeProvider);
    await withEstate(async (dir) => {
      const liveImport = fakeImport();
      const res = await carveEmit(
        { from: dir, select: "fake_widget.hero", env: "prod" },
        { plugins: [], liveImport },
      );
      expect(res.ok).toBe(true);
      expect(res.selector).toEqual({ type: "fake:Widget" });
      expect(liveImport.mock.calls[0][1]).toMatchObject({
        environment: "prod",
        selector: { type: "fake:Widget" },
        lexicon: "fakelex",
      });
      expect(formatCarveEmit(res)).toContain("Adopted live as fake:Widget");
    });
  });

  test("a ranked type the provider does not emit is refused identically on both paths", async () => {
    if (!parserAvailable) return;
    dispose = registerCarveProvider(fakeProvider);
    await withEstate(async (dir) => {
      const liveImport = fakeImport();
      const live = await carveEmit({ from: dir, select: "fake_gizmo.spare", env: "prod" }, { plugins: [], liveImport });
      const state = await carveEmit(
        { from: dir, select: "fake_gizmo.spare", statePath: join(dir, "terraform.tfstate") },
        { plugins: [], liveImport },
      );
      expect(live.ok).toBe(false);
      expect(state.ok).toBe(false);
      expect(live.error).toBe(state.error);
      expect(live.error).toContain("fake_gizmo cannot be emitted yet");
      expect(liveImport).not.toHaveBeenCalled();
    });
  });

  test("a state-only provider refuses --env instead of importing the wrong thing", async () => {
    if (!parserAvailable) return;
    dispose = registerCarveProvider(stateOnlyProvider);
    await withEstate(async (dir) => {
      const liveImport = fakeImport();
      const res = await carveEmit({ from: dir, select: "fake_widget.hero", env: "prod" }, { plugins: [], liveImport });
      expect(res.ok).toBe(false);
      expect(res.error).toContain("no live adoption path");
      expect(res.error).toContain("--state");
      expect(liveImport).not.toHaveBeenCalled();
    });
  });
});
