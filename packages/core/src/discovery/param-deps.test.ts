import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import { collectConsts } from "../fold/fold";
import { collectParamDependencies } from "./param-deps";
import type { PathOrigin } from "../provenance";

/**
 * Collect dependencies for the props of the file's single
 * `export const x = new Type({...})`, which is the shape every case here uses.
 */
function depsOf(source: string, paramLocals = ["params"]): Record<string, PathOrigin> {
  const file = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true);
  const consts = collectConsts(file);
  let props: ts.ObjectLiteralExpression | undefined;
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (decl.name.getText() !== "x" || !decl.initializer) continue;
      if (!ts.isNewExpression(decl.initializer)) continue;
      for (const argument of decl.initializer.arguments ?? []) {
        if (ts.isObjectLiteralExpression(argument)) {
          props = argument;
          break;
        }
      }
    }
  }
  if (!props) throw new Error("fixture has no `const x = new Type({...})`");
  return collectParamDependencies(props, consts, new Set(paramLocals));
}

const param = (...names: string[]): PathOrigin => ({ kind: "build-param", params: names });

describe("collectParamDependencies", () => {
  test("a direct read is attributed to its own path", () => {
    expect(depsOf(`export const x = new Thing({ replicas: params.replicas, name: "fixed" });`)).toEqual({
      replicas: param("replicas"),
    });
  });

  test("nested object literals are descended into, dotted", () => {
    const source = `export const x = new Thing({ spec: { template: { image: params.image } } });`;
    expect(depsOf(source)).toEqual({ "spec.template.image": param("image") });
  });

  test("an expression is attributed to every parameter it can read, not to its value", () => {
    const source = `export const x = new Thing({ replicas: params.tier === "prod" ? params.big : 1 });`;
    expect(depsOf(source)).toEqual({ replicas: param("big", "tier") });
  });

  test("a parameter hoisted into a const is followed to the field that uses it", () => {
    const source = [
      `const replicas = params.tier === "prod" ? 5 : 1;`,
      `export const x = new Thing({ replicas });`,
    ].join("\n");
    expect(depsOf(source)).toEqual({ replicas: param("tier") });
  });

  test("const chains are followed transitively, and a cycle terminates", () => {
    const source = [
      `const a = b;`,
      `const b = \`\${params.region}-\${a}\`;`,
      `export const x = new Thing({ zone: a });`,
    ].join("\n");
    expect(depsOf(source)).toEqual({ zone: param("region") });
  });

  test("template literals and calls are walked", () => {
    const source = `export const x = new Thing({ bucket: \`\${params.env}-assets\`.toLowerCase() });`;
    expect(depsOf(source)).toEqual({ bucket: param("env") });
  });

  test("an array is attributed whole, never per index", () => {
    const source = `export const x = new Thing({ containers: [{ image: params.image }, { image: "sidecar" }] });`;
    expect(depsOf(source)).toEqual({ containers: param("image") });
  });

  test("a spread is attributed to the object it spreads into", () => {
    const source = [
      `const base = { region: params.region };`,
      `export const x = new Thing({ ...base, spec: { ...base, replicas: 1 } });`,
    ].join("\n");
    expect(depsOf(source)).toEqual({ "": param("region"), spec: param("region") });
  });

  test("bracket access with a literal key names the parameter", () => {
    expect(depsOf(`export const x = new Thing({ zone: params["region"] });`)).toEqual({ zone: param("region") });
  });

  test("a property KEY that happens to match a const is not a reference", () => {
    const source = [`const tier = params.tier;`, `export const x = new Thing({ spec: { tier: "fixed" } });`].join("\n");
    expect(depsOf(source)).toEqual({});
  });

  test("a bare reference to the whole params object records nothing", () => {
    // It names no single parameter; under-reporting is the safe direction.
    expect(depsOf(`export const x = new Thing({ all: params });`)).toEqual({});
  });

  test("a file that never imported params records nothing", () => {
    expect(depsOf(`export const x = new Thing({ replicas: params.replicas });`, [])).toEqual({});
  });

  test("the local name the import bound is what counts, not the word 'params'", () => {
    const source = `export const x = new Thing({ replicas: p.replicas, other: params.replicas });`;
    expect(depsOf(source, ["p"])).toEqual({ replicas: param("replicas") });
  });

  test("parameter names are sorted and de-duplicated", () => {
    const source = `export const x = new Thing({ n: params.z + params.a + params.z });`;
    expect(depsOf(source)).toEqual({ n: param("a", "z") });
  });

  test("a computed key is skipped rather than guessed at", () => {
    const source = `export const x = new Thing({ [params.key]: 1, name: params.name });`;
    expect(depsOf(source)).toEqual({ name: param("name") });
  });
});
