/**
 * chant#2577 — a lexicon declared by path in `chant.config.ts` (#2520) gets the
 * same fold treatment as the same lexicon installed as a package, with and
 * without `--sandbox`.
 *
 * One lexicon source is written twice: once as the package
 * `@intentius/chant-lexicon-demo` under the fixture's own `node_modules`, and
 * once as `./lexicon/index.ts` named by path. The two projects differ only in
 * how `chant.config.ts` names the lexicon and in the specifier `main.ts`
 * imports it by. Each project's config is loaded, which is what records a
 * path-declared lexicon, and each is built with the lexicon list a CLI build
 * passes (the loaded plugins' names). The outputs and fold verdicts are compared.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "../../build";
import { loadChantConfig } from "../../config";
import { resetLexiconModules } from "../../lexicon-module";
import type { LexiconPlugin } from "../../lexicon";

const runtimePath = resolve(import.meta.dirname, "../../runtime");
const compositePath = resolve(import.meta.dirname, "../../composite");

const LEXICON_SOURCE = `
import { createResource } from ${JSON.stringify(runtimePath)};
import { Composite } from ${JSON.stringify(compositePath)};

export const Bucket = createResource("Demo::Bucket", "demo", { arn: "Arn" });
export const Role = createResource("Demo::Role", "demo", {});
export const Regions = { primary: "us-east-1" };

export const WebApp = Composite((props) => {
  const bucket = new Bucket({ bucketName: props.name });
  const role = new Role({ resource: bucket.arn });
  return { bucket, role };
}, "WebApp");

function plain(value) {
  if (value && typeof value === "object" && typeof value.getLogicalName === "function") {
    return { ref: value.getLogicalName(), attr: value.attribute };
  }
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

export const demoPlugin = {
  name: "demo",
  serializer: {
    name: "demo",
    rulePrefix: "DEMO",
    serialize: (entities) =>
      JSON.stringify(
        Object.fromEntries(
          [...entities.keys()].sort().map((name) => {
            const entity = entities.get(name);
            return [name, { type: entity.entityType, props: plain(entity.props) }];
          }),
        ),
      ),
  },
  generate: async () => {},
  validate: async () => {},
  coverage: async () => {},
  package: async () => {},
};
`;

function mainSource(specifier: string): string {
  return `
import { Bucket, Regions, WebApp } from ${JSON.stringify(specifier)};

export const logs = new Bucket({ bucketName: Regions.primary });
export const web = WebApp({ name: "data" });
`;
}

let root: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "chant-2577-")));

  const pkg = join(root, "pkg");
  const pkgDir = join(pkg, "node_modules", "@intentius", "chant-lexicon-demo");
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "@intentius/chant-lexicon-demo", type: "module", main: "index.ts" }),
  );
  await writeFile(join(pkgDir, "index.ts"), LEXICON_SOURCE);
  await mkdir(join(pkg, "src"));
  await writeFile(join(pkg, "src", "main.ts"), mainSource("@intentius/chant-lexicon-demo"));
  await writeFile(join(pkg, "chant.config.ts"), `export default { lexicons: ["demo"] };\n`);

  const path = join(root, "path");
  await mkdir(join(path, "lexicon"), { recursive: true });
  await writeFile(join(path, "lexicon", "index.ts"), LEXICON_SOURCE);
  await mkdir(join(path, "src"));
  await writeFile(join(path, "src", "main.ts"), mainSource("../lexicon"));
  await writeFile(
    join(path, "chant.config.ts"),
    `export default { lexicons: [{ name: "demo", module: "./lexicon/index.ts" }] };\n`,
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

afterEach(() => {
  resetLexiconModules();
});

async function buildProject(project: "pkg" | "path", modes: { fold: boolean; sandbox: boolean }) {
  const dir = join(root, project);
  const lexiconFile =
    project === "pkg"
      ? join(dir, "node_modules", "@intentius", "chant-lexicon-demo", "index.ts")
      : join(dir, "lexicon", "index.ts");
  await loadChantConfig(dir);
  const plugin = (await import(lexiconFile)).demoPlugin as LexiconPlugin;
  const result = await build(join(dir, "src"), [plugin.serializer], undefined, {
    ...modes,
    lexicons: [plugin.name],
  });
  return {
    errors: result.errors,
    output: result.outputs.get("demo") as string,
    decisions: result.foldDecisions.map((d) => ({ file: d.file.slice(dir.length), mode: d.mode, reason: d.reason })),
  };
}

describe("a lexicon declared by path folds like the same lexicon installed as a package (chant#2577)", () => {
  for (const modes of [
    { fold: true, sandbox: true },
    { fold: true, sandbox: false },
  ]) {
    test(
      `--fold${modes.sandbox ? " --sandbox" : ""}: same output, same fold verdicts`,
      async () => {
        const asPackage = await buildProject("pkg", modes);
        const byPath = await buildProject("path", modes);

        expect(asPackage.errors).toEqual([]);
        expect(byPath.errors).toEqual([]);
        expect(byPath.output).toBe(asPackage.output);
        expect(JSON.parse(byPath.output)).toEqual({
          logs: { type: "Demo::Bucket", props: { bucketName: "us-east-1" } },
          webBucket: { type: "Demo::Bucket", props: { bucketName: "data" } },
          webRole: { type: "Demo::Role", props: { resource: { ref: "webBucket", attr: "Arn" } } },
        });
        expect(byPath.decisions).toEqual(asPackage.decisions);
        expect(byPath.decisions).toEqual([{ file: "/src/main.ts", mode: "fold", reason: undefined }]);
      },
      60_000,
    );
  }
});
