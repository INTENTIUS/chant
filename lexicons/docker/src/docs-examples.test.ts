/**
 * The Dockerfile examples in the docs and skills build, and build what the
 * page says they do.
 *
 * - A ```typescript block with no title that declares a Dockerfile is run
 *   and serialized. When the next code block is an untitled ```dockerfile
 *   block, the built file must equal it.
 * - A titled ```typescript block (`title="src/web.ts"`) must equal that file
 *   in examples/dockerfile-sharing, and a titled ```dockerfile block
 *   (`title="Dockerfile.web"`) must equal that file from building the
 *   example.
 * - In importing.mdx, importing the ```dockerfile block titled "Dockerfile"
 *   must give the ```typescript block that follows it.
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import * as ts from "typescript";
import { build } from "@intentius/chant/build";
import * as chant from "@intentius/chant";
import type { Declarable } from "@intentius/chant/declarable";
import * as lexicon from "./index";
import { dockerSerializer } from "./serializer";
import { DockerTemplateGenerator, DockerTemplateParser } from "./import/adapter";

const root = join(import.meta.dirname, "..");
const sharingExample = join(root, "examples", "dockerfile-sharing");

interface Block {
  lang: string;
  title?: string;
  code: string;
  /** The prose between the previous code block and this one. */
  before: string;
}

function blocks(file: string): Block[] {
  const text = readFileSync(join(root, file), "utf8");
  const out: Block[] = [];
  let last = 0;
  for (const m of text.matchAll(/^```(\w+)([^\n]*)\n([\s\S]*?)^```$/gm)) {
    const title = m[2]!.match(/title="([^"]+)"/)?.[1];
    out.push({ lang: m[1]!, ...(title ? { title } : {}), code: m[3]!, before: text.slice(last, m.index) });
    last = m.index! + m[0].length;
  }
  return out;
}

/**
 * Run one TypeScript block as a module and serialize the Dockerfiles it
 * exports. A block whose first line is a path comment (`// src/web.ts`) is
 * one module of a multi-file example: `modules` holds the exports of the
 * page's earlier modules, by path, for its relative imports.
 */
function buildBlock(code: string, pageModules: Map<string, Record<string, unknown>> = new Map()): Record<string, string> {
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const modules: Record<string, unknown> = { "@intentius/chant-lexicon-docker": lexicon, "@intentius/chant": chant };
  const path = code.match(/^\/\/ (src\/\S+)\.ts\s*$/m)?.[1];
  const req = (name: string): unknown => {
    if (name.startsWith("./") && path) {
      const target = join(path, "..", name).replace(/\\/g, "/");
      const found = pageModules.get(target);
      if (found) return found;
    }
    if (!(name in modules)) throw new Error(`docs example imports ${name}, which this test does not provide`);
    return modules[name];
  };
  const mod = { exports: {} as Record<string, unknown> };
  // Snippets that leave out the import line still see the lexicon's exports.
  const globals = Object.keys(lexicon).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k));
  new Function("require", "module", "exports", ...globals, js)(req, mod, mod.exports, ...globals.map((k) => (lexicon as Record<string, unknown>)[k]));
  if (path) pageModules.set(path, mod.exports);
  const entities = new Map<string, Declarable>();
  for (const [name, value] of Object.entries(mod.exports)) {
    if (value && typeof value === "object" && "entityType" in value) entities.set(name, value as Declarable);
  }
  const result = dockerSerializer.serialize(entities);
  return typeof result === "string" ? {} : result.files;
}

const PAGES = [
  "docs/pages/dockerfiles.mdx",
  "docs/pages/examples.mdx",
  "docs/pages/lint-rules.mdx",
  "src/skills/chant-docker.md",
  "src/skills/chant-docker-patterns.md",
];

describe("docs Dockerfile examples", () => {
  for (const page of PAGES) {
    test(`${page}: every Dockerfile example builds what the page shows`, () => {
      const list = blocks(page);
      const pageModules = new Map<string, Record<string, unknown>>();
      let checked = 0;
      list.forEach((b, i) => {
        if (b.lang !== "typescript" || b.title) return;
        const isModule = /^\/\/ src\/\S+\.ts\s*$/m.test(b.code);
        if (!b.code.includes("new Dockerfile(") && !isModule) return;
        const files = buildBlock(b.code, pageModules);
        if (!b.code.includes("new Dockerfile(")) return;
        expect(Object.keys(files).length, `${page} block ${i + 1} declares a Dockerfile`).toBeGreaterThan(0);
        checked++;
        // The output shown right after it, under a "`Dockerfile.name`:" line.
        const next = list[i + 1];
        if (next && next.lang === "dockerfile" && !next.title && /^\s*`Dockerfile\.\w+`:\s*$/.test(next.before)) {
          expect(Object.values(files).join("---\n"), `${page} block ${i + 1}`).toBe(next.code);
        }
      });
      expect(checked, `${page} has Dockerfile examples`).toBeGreaterThan(0);
    });
  }

  test("dockerfiles.mdx sharing section matches the dockerfile-sharing example and its build", async () => {
    const titled = blocks("docs/pages/dockerfiles.mdx").filter((b) => b.title);
    const sources = titled.filter((b) => b.lang === "typescript");
    const outputs = titled.filter((b) => b.lang === "dockerfile");
    expect(sources.map((b) => b.title)).toEqual(["src/shared/node.ts", "src/web.ts", "src/worker.ts", "src/shared/node-image.ts", "src/api.ts"]);
    for (const b of sources) {
      expect(b.code, b.title).toBe(readFileSync(join(sharingExample, b.title!), "utf8"));
    }

    const result = await build(join(sharingExample, "src"), [dockerSerializer]);
    expect(result.errors).toEqual([]);
    const files = (result.outputs.get("docker") as unknown as { files: Record<string, string> }).files;
    expect(outputs.map((b) => b.title).sort()).toEqual(Object.keys(files).sort());
    for (const b of outputs) {
      expect(b.code, b.title).toBe(files[b.title!]);
    }
  });

  test("importing.mdx shows what importing its Dockerfile produces", () => {
    const list = blocks("docs/pages/importing.mdx");
    const at = list.findIndex((b) => b.lang === "dockerfile" && b.title === "Dockerfile");
    expect(at).toBeGreaterThan(-1);
    const [file] = new DockerTemplateGenerator().generate(new DockerTemplateParser().parse(list[at]!.code));
    expect(list[at + 1]!.code).toBe(file!.content.endsWith("\n") ? file!.content : `${file!.content}\n`);
    // And building the import gives the Dockerfile back.
    expect(Object.values(buildBlock(list[at + 1]!.code))[0]).toBe(list[at]!.code.replace(/^#.*\n/gm, ""));
  });
});
