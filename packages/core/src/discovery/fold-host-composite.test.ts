import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldProject } from "../index";

/**
 * chant#2442 — a host may supply the composite registration form.
 *
 * `findCompositeDefinition` required `Composite` to be chant's own, which is
 * right for a chant project and is the provenance question #1082 settled: a
 * project-local `function Composite(...)` shadowing the name is not chant's,
 * and a call to it is not a registered composite.
 *
 * It had never had to consider a HOST supplying the form
 * (`F-Host-Composite`), because a chant project's active packages are always
 * lexicons and no lexicon exports a `Composite`. Reaching it at all requires a
 * caller that named its own host packages
 * (`FoldProjectOptions.lexiconPackages`, chant#2438), so nothing about a chant
 * build changes.
 *
 * Two halves, and the second is the one with teeth. Recognising the form gets
 * interpretation started; the members it produces are then the HOST's, and
 * wrapping them in chant's `Composite` would run chant's member validation,
 * which asks for chant's own `Declarable` and rejects an entity carrying a
 * different marker — rejecting it for not being chant's rather than for being
 * malformed.
 */
describe("a host's composite registration form (chant#2442)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "chant-host-composite-"));
    const pkg = join(root, "node_modules", "@tsad", "shapes");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ name: "@tsad/shapes", version: "0.0.0", type: "module", main: "index.js" }),
    );
    // An entity carrying its OWN marker, not chant's, and the host's own
    // registration form. This is the shape the specification's `shapes` host
    // has and the reason chant's member validation refused it.
    writeFileSync(
      join(pkg, "index.js"),
      [
        "const MARK = Symbol.for('tsad.conformance.declarable');",
        "export class Bucket {",
        "  constructor(props = {}) {",
        "    this.entityType = 'Bucket'; this.lexicon = 'shapes'; this.props = props;",
        "    Object.defineProperty(this, MARK, { value: true, enumerable: false });",
        "  }",
        "}",
        "export function Composite(factory, name) {",
        "  const d = (props) => factory(props); d.compositeName = name; return d;",
        "}",
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(root, "shapes.ts"),
      'import { Bucket, Composite } from "@tsad/shapes";\n' +
        'export const Store = Composite(({ name }) => ({ bucket: new Bucket({ name }) }), "Store");\n',
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const app = (source: string): string => {
    const file = join(root, "app.ts");
    writeFileSync(file, source);
    return file;
  };

  test("a call to the host's composite folds to the host's own members", async () => {
    const file = app('import { Store } from "./shapes";\nexport const s = Store({ name: "a" });\n');

    // `--sandbox` is what the specification calls isolated, and it is the
    // setting that proves interpretation rather than invocation: invoking would
    // import a project module, which the sandbox refuses.
    const verdict = (
      await foldProject([file], [], { lexiconPackages: ["@tsad/shapes"], sandbox: true })
    ).get(file)!;

    expect(verdict.verdict).toBe("fold");
    expect(JSON.parse(JSON.stringify(Object.fromEntries(verdict.exports!)))).toEqual({
      s: { bucket: { entityType: "Bucket", lexicon: "shapes", props: { name: "a" } } },
    });
  });

  test("a factory outside the subset is still refused rather than invoked", async () => {
    // `S-FactoryParams`: two parameters is outside it, so interpretation
    // declines and the invocation arm refuses under the sandbox.
    writeFileSync(
      join(root, "shapes.ts"),
      'import { Bucket, Composite } from "@tsad/shapes";\n' +
        'export const Two = Composite((a, b) => ({ bucket: new Bucket({ name: a.name + b }) }), "Two");\n',
    );
    const file = app('import { Two } from "./shapes";\nexport const s = Two({ name: "a" }, "b");\n');

    const verdict = (
      await foldProject([file], [], { lexiconPackages: ["@tsad/shapes"], sandbox: true })
    ).get(file)!;

    expect(verdict.verdict).toBe("run");
  });

  test("the form is only recognised when the caller named the package", async () => {
    const file = app('import { Store } from "./shapes";\nexport const s = Store({ name: "a" });\n');

    // Unnamed, the host package is not resolvable, so nothing about the
    // registration form is reached and the sandbox refuses the invocation arm.
    const verdict = (await foldProject([file], [], { sandbox: true })).get(file)!;

    expect(verdict.verdict).toBe("run");
  });
});
