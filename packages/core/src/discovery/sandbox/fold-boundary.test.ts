import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { discover } from "../index";

/**
 * chant #1093 — the security property `--sandbox` is supposed to buy, tested
 * where it was actually broken.
 *
 * chant #1045 isolates the run-fallback set, and `../sandbox/run.test.ts`
 * proves THAT boundary holds (no reads outside the project, no writes, no
 * spawning, no ambient env). It says nothing about the FOLD half, which is
 * where the hole was: fold executes none of a file's own top-level code, but
 * it resolves a composite factory / resource constructor / intrinsic tag by
 * importing the module that defines it and invoking it. When that module is a
 * sibling project file, a file reported as `mode: "fold"` had nonetheless run
 * project code — its module top level AND the factory body — inside the CLI's
 * own process, with the CLI's filesystem, network, environment and
 * process-spawning access.
 *
 * These tests observe execution DIRECTLY rather than inferring it: the fixture
 * sets a `globalThis` marker at module top level and another inside the
 * factory body. A marker set inside the sandboxed child cannot reach this
 * process — it is a different process — so "marker present" is precisely
 * "this ran in the CLI process". The plain-`--fold` case is asserted first in
 * every pair, so the probe is proven to be capable of firing before the
 * `--sandbox` case asserts that it doesn't.
 *
 * Fixtures are written to a fresh tmpdir per test (never into the source
 * tree), which also keeps each test's module paths unique — no module-cache
 * bleed between the two halves of a pair.
 */

const thisDir = dirname(fileURLToPath(import.meta.url));
/** Absolute paths to chant-core's real modules, imported by the fixtures the way a lexicon package would be. */
const runtimePath = resolve(thisDir, "../../runtime");
const compositePath = resolve(thisDir, "../../composite");

const MODULE_MARKER = "__chant1093ModuleEvaluated";
const FACTORY_MARKER = "__chant1093FactoryInvoked";

type MarkerHost = Record<string, boolean | undefined>;

function marker(name: string): boolean | undefined {
  return (globalThis as unknown as MarkerHost)[name];
}

function clearMarkers(): void {
  delete (globalThis as unknown as MarkerHost)[MODULE_MARKER];
  delete (globalThis as unknown as MarkerHost)[FACTORY_MARKER];
}

describe("fold under --sandbox never executes project code in the CLI process (chant #1093)", () => {
  let testDir: string;
  let seq = 0;

  beforeEach(async () => {
    const dir = join(tmpdir(), `chant-1093-fold-boundary-${Date.now()}-${Math.random()}`);
    await mkdir(dir, { recursive: true });
    testDir = await realpath(dir);
    clearMarkers();
  });

  afterEach(async () => {
    clearMarkers();
    await rm(testDir, { recursive: true, force: true });
  });

  /**
   * A project-owned composite factory: the shape chant#1022/#1023 folds by
   * importing `./composites` and calling `WebApp(...)` for real.
   */
  async function writeCompositeFixture(): Promise<void> {
    await writeFile(
      join(testDir, "composites.ts"),
      `
        import { Composite } from ${JSON.stringify(compositePath)};
        import { createResource } from ${JSON.stringify(runtimePath)};

        globalThis[${JSON.stringify(MODULE_MARKER)}] = true;

        const Bucket = createResource("Test::Bucket", "test", { arn: "Arn" });
        const Role = createResource("Test::Role", "test", {});

        export const WebApp = Composite((props) => {
          globalThis[${JSON.stringify(FACTORY_MARKER)}] = true;
          const bucket = new Bucket({ bucketName: props.name });
          const role = new Role({ resource: bucket.arn });
          return { bucket, role };
        }, "WebApp");
      `,
    );
    await writeFile(
      join(testDir, "main.ts"),
      `
        import { WebApp } from "./composites";
        export const web = WebApp({ name: "data" });
      `,
    );
  }

  test("plain --fold DOES invoke a project-owned composite factory in-process (the probe fires)", async () => {
    await writeCompositeFixture();

    const result = await discover(testDir, { fold: true });

    // The file folds today — and folding it ran project code right here.
    const main = result.foldDecisions.find((d) => d.file.endsWith("main.ts"));
    expect(main?.mode).toBe("fold");
    expect(marker(MODULE_MARKER), "composites.ts's module top level ran in this process").toBe(true);
    expect(marker(FACTORY_MARKER), "the factory body ran in this process").toBe(true);
    expect([...result.entities.keys()].sort()).toEqual(["webBucket", "webRole"]);
  });

  test("--sandbox invokes it in the child instead: no marker here, same entities", async () => {
    await writeCompositeFixture();

    const result = await discover(testDir, { fold: true, sandbox: true });

    expect(result.errors).toEqual([]);
    // Same entities, produced by the same factory with the same arguments —
    // just on the other side of the boundary.
    expect([...result.entities.keys()].sort()).toEqual(["webBucket", "webRole"]);
    expect(marker(MODULE_MARKER), "project module top level must NOT run in the CLI process").toBeUndefined();
    expect(marker(FACTORY_MARKER), "the factory body must NOT run in the CLI process").toBeUndefined();

    // The demotion is reported, with a reason that names the cause.
    const main = result.foldDecisions.find((d) => d.file.endsWith("main.ts"));
    expect(main?.mode).toBe("run");
    expect(main?.reason).toContain("--sandbox");
    expect(main?.reason).toContain("./composites");
  });

  test("the cross-file AttrRef still resolves through the boundary", async () => {
    await writeCompositeFixture();

    const result = await discover(testDir, { fold: true, sandbox: true });

    // `role.props.resource` is `bucket.arn`, an AttrRef whose logical name is
    // assigned by naming INSIDE the child (chant#1045's design) — the same
    // value the in-process fold produces, reached without executing anything
    // here.
    const role = result.entities.get("webRole") as unknown as { props: { resource: unknown } };
    const ref = role.props.resource as { getLogicalName?: () => string | undefined; attribute?: string };
    expect(ref.getLogicalName?.()).toBe("webBucket");
    expect(ref.attribute).toBe("Arn");
  });

  /**
   * The same hole, reached through `new Type(...)` rather than a factory call:
   * a resource class is a lexicon export in every corpus entry today, but
   * nothing in the language or the folder requires that.
   */
  async function writeConstructorFixture(): Promise<void> {
    await writeFile(
      join(testDir, "resources.ts"),
      `
        import { createResource } from ${JSON.stringify(runtimePath)};
        globalThis[${JSON.stringify(MODULE_MARKER)}] = true;
        export const Bucket = createResource("Test::Bucket", "test", { arn: "Arn" });
      `,
    );
    await writeFile(
      join(testDir, "main.ts"),
      `
        import { Bucket } from "./resources";
        export const dataBucket = new Bucket({ bucketName: "data" });
      `,
    );
  }

  test("plain --fold DOES evaluate a project-owned constructor module in-process", async () => {
    await writeConstructorFixture();

    const result = await discover(testDir, { fold: true });

    expect(result.foldDecisions.find((d) => d.file.endsWith("main.ts"))?.mode).toBe("fold");
    expect(marker(MODULE_MARKER)).toBe(true);
    expect([...result.entities.keys()]).toEqual(["dataBucket"]);
  });

  test("--sandbox demotes a project-owned constructor too", async () => {
    await writeConstructorFixture();

    const result = await discover(testDir, { fold: true, sandbox: true });

    expect(result.errors).toEqual([]);
    expect([...result.entities.keys()]).toEqual(["dataBucket"]);
    expect(marker(MODULE_MARKER)).toBeUndefined();
    const main = result.foldDecisions.find((d) => d.file.endsWith("main.ts"));
    expect(main?.mode).toBe("run");
    expect(main?.reason).toContain("--sandbox");
  });

  /**
   * The allowlist is a boundary, not a blanket ban: a factory owned by one of
   * THIS build's active lexicon packages still folds in-process under
   * `--sandbox`. That is deliberate and is exactly chant#1045's stated scope
   * ("sandboxing chant itself, or the lexicon packages" is a non-goal) — the
   * CLI has already imported and executed every active lexicon package
   * (`loadPlugins`) before discovery starts.
   *
   * Same fixture, same specifier, in both halves below — the ONLY difference
   * is whether the build declared that lexicon as active.
   */
  async function installLexiconPackage(): Promise<{ lexicon: string; specifier: string }> {
    const lexicon = `fold1093x${seq++}${Date.now().toString(36)}`;
    const specifier = `@intentius/chant-lexicon-${lexicon}`;
    const dir = join(testDir, "node_modules", specifier);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ name: specifier, version: "0.0.0", type: "module", exports: { ".": "./index.js" } }),
    );
    await writeFile(
      join(dir, "index.js"),
      `
        const DECLARABLE_MARKER = Symbol.for("chant.declarable");
        export function Widget(props) {
          return { [DECLARABLE_MARKER]: true, lexicon: "test", entityType: "Test::Widget", kind: "resource", props };
        }
      `,
    );
    await writeFile(
      join(testDir, "main.ts"),
      `
        import { Widget } from ${JSON.stringify(specifier)};
        export const widget = Widget({ size: "large" });
      `,
    );
    return { lexicon, specifier };
  }

  test("a factory from an ACTIVE lexicon package still folds under --sandbox", async () => {
    const { lexicon } = await installLexiconPackage();

    const result = await discover(testDir, { fold: true, sandbox: true, lexicons: [lexicon] });

    expect(result.foldDecisions.find((d) => d.file.endsWith("main.ts"))?.mode).toBe("fold");
    expect([...result.entities.keys()]).toEqual(["widget"]);
  });

  test("the same factory from a lexicon this build did NOT load is refused", async () => {
    await installLexiconPackage();

    const result = await discover(testDir, { fold: true, sandbox: true, lexicons: ["aws"] });

    const main = result.foldDecisions.find((d) => d.file.endsWith("main.ts"));
    expect(main?.mode).toBe("run");
    expect(main?.reason).toContain("--sandbox");
  });
});
