/**
 * chant#2590 — every file of a multi-file lexicon declared by path gets the
 * fold trust a subpath of the same lexicon installed as a package gets, with
 * and without `--sandbox`.
 *
 * The lexicon is three files: `resources.ts`, `composites.ts` (which imports
 * `./resources`) and `index.ts` (which re-exports both and holds the plugin).
 * It is written once as the package `@intentius/chant-lexicon-demo` and once
 * as `./lexicon/` named by path. One project file imports the lexicon's entry
 * and one imports a constructor from its `resources` file directly, by
 * package subpath or by path. Outputs and fold verdicts are compared.
 *
 * The rest of the file covers the bounds of the trusted directory.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "../../build";
import { loadChantConfig } from "../../config";
import { lexiconModuleRoot, pathLexiconRoot, resetLexiconModules } from "../../lexicon-module";
import { createFoldSession } from "../fold-import";
import type { LexiconPlugin } from "../../lexicon";

const runtimePath = resolve(import.meta.dirname, "../../runtime");
const compositePath = resolve(import.meta.dirname, "../../composite");

const RESOURCES = `
import { createResource } from ${JSON.stringify(runtimePath)};

export const Bucket = createResource("Demo::Bucket", "demo", { arn: "Arn" });
export const Role = createResource("Demo::Role", "demo", {});
`;

const COMPOSITES = `
import { Composite } from ${JSON.stringify(compositePath)};
import { Bucket, Role } from "./resources";

export const WebApp = Composite((props) => {
  const bucket = new Bucket({ bucketName: props.name });
  const role = new Role({ resource: bucket.arn });
  return { bucket, role };
}, "WebApp");
`;

const INDEX = `
export * from "./resources";
export * from "./composites";

export const Regions = { primary: "us-east-1" };

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

function mainSource(entry: string): string {
  return `
import { Bucket, Regions, WebApp } from ${JSON.stringify(entry)};

export const logs = new Bucket({ bucketName: Regions.primary });
export const web = WebApp({ name: "data" });
`;
}

function rolesSource(resources: string): string {
  return `
import { Role } from ${JSON.stringify(resources)};

export const deployer = new Role({ resource: "deploy" });
`;
}

async function writeLexicon(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "resources.ts"), RESOURCES);
  await writeFile(join(dir, "composites.ts"), COMPOSITES);
  await writeFile(join(dir, "index.ts"), INDEX);
}

let root: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "chant-2590-")));

  const pkg = join(root, "pkg");
  const pkgDir = join(pkg, "node_modules", "@intentius", "chant-lexicon-demo");
  await writeLexicon(pkgDir);
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@intentius/chant-lexicon-demo",
      type: "module",
      exports: { ".": "./index.ts", "./resources": "./resources.ts" },
    }),
  );
  await mkdir(join(pkg, "src"));
  await writeFile(join(pkg, "src", "main.ts"), mainSource("@intentius/chant-lexicon-demo"));
  await writeFile(join(pkg, "src", "roles.ts"), rolesSource("@intentius/chant-lexicon-demo/resources"));
  await writeFile(join(pkg, "chant.config.ts"), `export default { lexicons: ["demo"] };\n`);

  const path = join(root, "path");
  await writeLexicon(join(path, "lexicon"));
  await mkdir(join(path, "src"));
  await writeFile(join(path, "src", "main.ts"), mainSource("../lexicon"));
  await writeFile(join(path, "src", "roles.ts"), rolesSource("../lexicon/resources"));
  await writeFile(
    join(path, "chant.config.ts"),
    `export default { lexicons: [{ name: "demo", module: "./lexicon/index.ts" }] };\n`,
  );

  // The same lexicon with its module at the project root: only the module
  // file is trusted, so its sibling stays a project file.
  const flat = join(root, "flat");
  await mkdir(join(flat, "src"), { recursive: true });
  await writeFile(join(flat, "resources.ts"), RESOURCES);
  await writeFile(join(flat, "composites.ts"), COMPOSITES);
  await writeFile(join(flat, "demo.ts"), INDEX);
  await writeFile(join(flat, "src", "roles.ts"), rolesSource("../resources"));
  await writeFile(join(flat, "chant.config.ts"), `export default { lexicons: [{ name: "demo", module: "./demo.ts" }] };\n`);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

afterEach(() => {
  resetLexiconModules();
});

async function buildProject(project: "pkg" | "path" | "flat", modes: { fold: boolean; sandbox: boolean }) {
  const dir = join(root, project);
  const lexiconFile = {
    pkg: join(dir, "node_modules", "@intentius", "chant-lexicon-demo", "index.ts"),
    path: join(dir, "lexicon", "index.ts"),
    flat: join(dir, "demo.ts"),
  }[project];
  await loadChantConfig(dir);
  const plugin = (await import(lexiconFile)).demoPlugin as LexiconPlugin;
  const result = await build(join(dir, "src"), [plugin.serializer], undefined, {
    ...modes,
    lexicons: [plugin.name],
  });
  return {
    errors: result.errors,
    output: result.outputs.get("demo") as string,
    decisions: result.foldDecisions
      .map((d) => ({ file: d.file.slice(dir.length), mode: d.mode, reason: d.reason }))
      .sort((a, b) => a.file.localeCompare(b.file)),
  };
}

describe("a multi-file lexicon declared by path folds like the same lexicon installed as a package (chant#2590)", () => {
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
          deployer: { type: "Demo::Role", props: { resource: "deploy" } },
          logs: { type: "Demo::Bucket", props: { bucketName: "us-east-1" } },
          webBucket: { type: "Demo::Bucket", props: { bucketName: "data" } },
          webRole: { type: "Demo::Role", props: { resource: { ref: "webBucket", attr: "Arn" } } },
        });
        expect(byPath.decisions).toEqual(asPackage.decisions);
        expect(byPath.decisions).toEqual([
          { file: "/src/main.ts", mode: "fold", reason: undefined },
          { file: "/src/roles.ts", mode: "fold", reason: undefined },
        ]);
      },
      60_000,
    );
  }

  test("a module at the project root trusts only itself: under --sandbox its sibling runs in the child", async () => {
    const flat = await buildProject("flat", { fold: true, sandbox: true });
    expect(flat.errors).toEqual([]);
    expect(JSON.parse(flat.output)).toEqual({ deployer: { type: "Demo::Role", props: { resource: "deploy" } } });
    expect(flat.decisions).toHaveLength(1);
    expect(flat.decisions[0]).toMatchObject({ file: "/src/roles.ts", mode: "run" });
    expect(flat.decisions[0].reason).toContain("neither chant's own nor an active lexicon");
  }, 60_000);
});

describe("the trusted directory's bounds (chant#2590)", () => {
  const project = "/p";

  test("defaults to the module's own directory", () => {
    expect(pathLexiconRoot({ module: "./lexicon/index.ts" }, project)).toEqual({ root: "/p/lexicon" });
  });

  test("a module at the project root gets no directory", () => {
    expect(pathLexiconRoot({ module: "./demo.ts" }, project)).toEqual({});
  });

  test("a module outside the project gets no directory", () => {
    expect(pathLexiconRoot({ module: "/elsewhere/demo.ts" }, project)).toEqual({});
  });

  test("the module's directory is dropped when it contains the source directory", () => {
    expect(pathLexiconRoot({ module: "./infra/lexicon.ts" }, project, "infra/src")).toEqual({});
    expect(pathLexiconRoot({ module: "./infra/lexicon.ts" }, project, "infra")).toEqual({});
  });

  test("a declared root is used when it holds the module", () => {
    expect(pathLexiconRoot({ module: "./lexicon/src/index.ts", root: "./lexicon" }, project)).toEqual({
      root: "/p/lexicon",
    });
  });

  test("a declared root outside the project, over the source, or not holding the module is a problem", () => {
    expect(pathLexiconRoot({ module: "./lexicon/index.ts", root: ".." }, project).problem).toContain("outside the project");
    expect(pathLexiconRoot({ module: "./lexicon/index.ts", root: "." }, project).problem).toContain(
      "contains the project's source directory",
    );
    expect(pathLexiconRoot({ module: "./lexicon/index.ts", root: "./other" }, project).problem).toContain(
      "is not inside",
    );
  });

  test("the config loader refuses a declared root that breaks a rule", async () => {
    const dir = join(root, "bad-root");
    await mkdir(join(dir, "lexicon"), { recursive: true });
    await writeFile(
      join(dir, "chant.config.json"),
      JSON.stringify({ lexicons: [{ name: "demo", module: "./lexicon/index.ts", root: "." }] }),
    );
    await expect(loadChantConfig(dir)).rejects.toThrow(/lexicons\.0\.root: .*contains the project's source directory/);
  });

  test("the config loader records a declared root", async () => {
    const dir = join(root, "good-root");
    await mkdir(join(dir, "lexicon", "src"), { recursive: true });
    await writeFile(
      join(dir, "chant.config.json"),
      JSON.stringify({ lexicons: [{ name: "demo", module: "./lexicon/src/index.ts", root: "./lexicon" }] }),
    );
    await loadChantConfig(dir);
    expect(lexiconModuleRoot("demo")).toBe(join(dir, "lexicon"));
  });

  test("a fold session drops a directory holding any of the build's own source files", async () => {
    const dir = join(root, "path");
    await loadChantConfig(dir);
    expect(createFoldSession([], undefined, ["demo"]).lexiconRoots).toEqual([join(dir, "lexicon")]);
    const session = createFoldSession([], undefined, ["demo"], true, [], false, [join(dir, "lexicon", "extra.ts")]);
    expect(session.lexiconRoots).toEqual([]);
  });
});
