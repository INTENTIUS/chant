/**
 * Docker TypeScript that the repo typecheck can't see type-checks against the
 * lexicon (#3934): the examples in the docs and skills, and the source
 * `chant import` writes for the compose fixtures. The constructors take their
 * props types, so an example with a misspelled field or a wrong value type
 * fails here rather than in a reader's editor. Compiling them takes longer
 * than the unit-test budget allows, so this runs with the e2e tests.
 *
 * A snippet that leaves out its import line is checked as if it imported the
 * lexicon names it uses; a titled block or a `// src/x.ts` module block is
 * placed at that path so the page's relative imports resolve.
 */

import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import * as ts from "typescript";
import * as lexicon from "./index";
import { DockerParser } from "./import/parser";
import { DockerGenerator } from "./import/generator";

const root = join(import.meta.dirname, "..");
const repoRoot = join(root, "..", "..");
const virtualRoot = join(root, ".typecheck");

interface Block {
  lang: string;
  title?: string;
  code: string;
}

function blocks(file: string): Block[] {
  const text = readFileSync(join(root, file), "utf8");
  return [...text.matchAll(/^```(\w+)([^\n]*)\n([\s\S]*?)^```$/gm)].map((m) => {
    const title = m[2]!.match(/title="([^"]+)"/)?.[1];
    return { lang: m[1]!, ...(title ? { title } : {}), code: m[3]! };
  });
}

/** Type errors in in-memory files, compiled against the lexicon's source with the repo typecheck's options. */
function typeErrors(files: Map<string, string>): string[] {
  const config = ts.readConfigFile(join(repoRoot, "tsconfig.typecheck.json"), ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, repoRoot);
  const checkOptions = { ...options, noEmit: true, types: [], skipLibCheck: true, declaration: false, declarationMap: false, sourceMap: false };
  const host = ts.createCompilerHost(checkOptions);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang, ...rest) =>
    files.has(name) ? ts.createSourceFile(name, files.get(name)!, lang) : getSourceFile(name, lang, ...rest);
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (name) => files.has(name) || fileExists(name);
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (dir) => [...files.keys()].some((f) => f.startsWith(`${dir}/`)) || (directoryExists?.(dir) ?? false);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => files.get(name) ?? readFile(name);

  const program = ts.createProgram([...files.keys()], checkOptions, host);
  // Only the in-memory files are checked; the lexicon itself is the repo typecheck's job.
  return [...files.keys()]
    .flatMap((f) => {
      const sf = program.getSourceFile(f)!;
      return [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
    })
    .map((d) => {
      const { line } = d.file!.getLineAndCharacterOfPosition(d.start ?? 0);
      return `${d.file!.fileName.slice(virtualRoot.length + 1)}:${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
    });
}

describe("docker TypeScript outside the repo typecheck type-checks", () => {
  test("every docker example in the docs and skills", () => {
    const pages = [
      ...readdirSync(join(root, "docs/pages")).filter((f) => f.endsWith(".mdx")).map((f) => `docs/pages/${f}`),
      ...readdirSync(join(root, "src/skills")).filter((f) => f.endsWith(".md")).map((f) => `src/skills/${f}`),
    ];
    const lexiconNames = Object.keys(lexicon);
    const typeNames = ["DockerfileProps", "DockerfileStage", "DockerfileStep", "DockerfileInstructionName", "ServiceProps", "VolumeProps", "NetworkProps", "DockerConfigProps", "DockerSecretProps"];
    const files = new Map<string, string>();
    for (const page of pages) {
      blocks(page).forEach((b, i) => {
        if (b.lang !== "typescript") return;
        const modulePath = b.title ?? b.code.match(/^\/\/ (src\/\S+\.ts)\s*$/m)?.[1];
        if (!modulePath && !/@intentius\/chant-lexicon-docker|new (Dockerfile|Service|Volume|Network|DockerConfig|DockerSecret)\(/.test(b.code)) return;
        // A snippet sits one directory below src/, so `../web/main` and `./shared/node` reach the page's modules.
        const file = join(virtualRoot, page.replace(/[/.]/g, "_"), modulePath ?? `src/snippets/block-${i + 1}.ts`);
        let code = b.code;
        if (!code.includes("@intentius/chant-lexicon-docker")) {
          const used = [...lexiconNames, ...typeNames].filter((n) => new RegExp(`\\b${n}\\b`).test(code));
          if (used.length) code = `import { ${used.join(", ")} } from "@intentius/chant-lexicon-docker";\n${code}`;
        }
        files.set(file, `${code}\nexport {};\n`);
      });
    }
    expect(files.size).toBeGreaterThan(20);
    expect(typeErrors(files)).toEqual([]);
  }, 120_000);

  test("what importing the compose fixtures writes", () => {
    const testdata = join(root, "src/import/testdata");
    const files = new Map<string, string>();
    for (const fixture of readdirSync(testdata).filter((f) => f.endsWith(".yaml"))) {
      const { source } = new DockerGenerator().generate(new DockerParser().parse(readFileSync(join(testdata, fixture), "utf8")).entities);
      files.set(join(virtualRoot, "import", `${fixture.replace(/\.yaml$/, "")}.ts`), source);
    }
    expect(files.size).toBeGreaterThanOrEqual(4);
    expect(typeErrors(files)).toEqual([]);
  }, 120_000);
});
