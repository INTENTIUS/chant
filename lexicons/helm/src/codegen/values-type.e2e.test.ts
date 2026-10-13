import { describe, expect, test } from "vitest";
import yaml from "js-yaml";
import ts from "typescript";
import { inferValuesType } from "./values-type";

/** Type-check `const v: Values = <value>` against the inferred type. */
function accepts(valuesYaml: string, value: string): string[] {
  const code = `type Values = ${inferValuesType(yaml.load(valuesYaml))};\nexport const v: Values = ${value};\n`;
  const fileName = "/virtual/v.ts";
  const options: ts.CompilerOptions = { strict: true, noEmit: true, lib: ["lib.es2022.d.ts"] };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  host.getSourceFile = (name, lang, ...rest) => (name === fileName ? ts.createSourceFile(name, code, lang) : original.call(host, name, lang, ...rest));
  const program = ts.createProgram([fileName], options, host);
  return ts.getPreEmitDiagnostics(program, program.getSourceFile(fileName)).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
}

const VALUES = `
replicaCount: 1
image:
  repository: traefik
  tag: ""
  pullPolicy: IfNotPresent
podAnnotations: {}
tolerations: []
nodeSelector:
resources: ~
ports:
  - name: web
    port: 8000
  - name: websecure
    port: 8443
    tls: true
"app.kubernetes.io/part-of": edge
use-forwarded-headers: false
`;

describe("inferValuesType", () => {
  test("every member is optional and typed from its default", () => {
    const type = inferValuesType(yaml.load(VALUES));
    expect(type).toContain("  replicaCount?: number;");
    expect(type).toContain("    tag?: string;");
    expect(type).toContain(`  "app.kubernetes.io/part-of"?: string;`);
    expect(type).toContain(`  "use-forwarded-headers"?: boolean;`);
  });

  test("null and empty defaults say nothing about the type", () => {
    const type = inferValuesType(yaml.load(VALUES));
    expect(type).toContain("  nodeSelector?: unknown;");
    expect(type).toContain("  resources?: unknown;");
    expect(type).toContain("  podAnnotations?: Record<string, unknown>;");
    expect(type).toContain("  tolerations?: unknown[];");
  });

  test("list elements merge their keys", () => {
    const type = inferValuesType(yaml.load(VALUES));
    expect(type).toMatch(/ports\?: Array<\{\n {4}name\?: string;\n {4}port\?: number;\n {4}tls\?: boolean;\n {2}\}>;/);
  });

  test("a subset of overrides typechecks; a misspelled or mistyped key does not", () => {
    expect(accepts(VALUES, `{ image: { tag: "v3" }, podAnnotations: { a: "b" }, resources: { limits: {} } }`)).toEqual([]);
    expect(accepts(VALUES, `{ image: { tga: "v3" } }`).join("\n")).toMatch(/'tga' does not exist/);
    expect(accepts(VALUES, `{ replicaCount: "2" }`)).not.toEqual([]);
  });

  test("an empty values file is an open map", () => {
    expect(inferValuesType(yaml.load(""))).toBe("Record<string, unknown>");
  });
});
