/**
 * The generated declarations (`src/generated/index.d.ts`) hold a declaration
 * to what GitHub Actions accepts (#3670). Each snippet is compiled against
 * them in memory, so a type narrower than the workflow syntax fails here.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const DTS = readFileSync(join(import.meta.dirname, "generated", "index.d.ts"), "utf-8");

/** The diagnostics from compiling `body` against the generated declarations. */
function diagnostics(body: string): string[] {
  const files: Record<string, string> = {
    "/gh.d.ts": DTS,
    "/main.ts": `import { Container, Service, Step } from "./gh";\n${body}\n`,
  };
  const options: ts.CompilerOptions = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, types: [], lib: ["lib.es2022.d.ts"] };
  const host = ts.createCompilerHost(options);
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, lang) => (name in files ? ts.createSourceFile(name, files[name], lang) : read(name, lang));
  host.fileExists = (name) => name in files || ts.sys.fileExists(name);
  host.readFile = (name) => files[name] ?? ts.sys.readFile(name);
  const program = ts.createProgram(["/main.ts"], options, host);
  return ts.getPreEmitDiagnostics(program, program.getSourceFile("/main.ts")).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

describe("generated types (#3670)", () => {
  test("Service and Container ports take host:container strings as well as numbers", () => {
    expect(diagnostics(`
      new Service({ image: "clickhouse/clickhouse-server:24", ports: ["8123:8123", 9000] });
      new Container({ image: "node:22", ports: ["3000:3000"] });
    `)).toEqual([]);
  });

  test("Step with takes numbers and booleans as well as strings", () => {
    expect(diagnostics(`new Step({ uses: "actions/checkout@v4", with: { "fetch-depth": 0, lfs: true, ref: "main" } });`)).toEqual([]);
  });

  test("the declarations still reject what the syntax does not take", () => {
    expect(diagnostics(`new Service({ image: "x", ports: [{ port: 1 }] });`)).not.toEqual([]);
    expect(diagnostics(`new Step({ with: { inputs: ["a"] } });`)).not.toEqual([]);
  });
});
