import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import { collectConsts } from "../fold/fold";
import { collectCompositeOrigins, collectParamDependencies } from "./param-deps";
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

/**
 * chant #2161 — the same walk over a composite factory's own parameter.
 *
 * The fixture shape is a factory body: the file is `const f = (<param>) => {
 * <consts> return new Thing({...}); }`, so the body consts are in scope exactly
 * as {@link import("./fold-import").interpretCompositeFactory} arranges them.
 */
function compositeOriginsOf(
  body: string,
  scope: { whole?: string[]; destructured?: Record<string, string> } = { whole: ["props"] },
): Record<string, PathOrigin> {
  const source = `const f = (p) => { ${body} };`;
  const file = ts.createSourceFile("factory.ts", source, ts.ScriptTarget.Latest, true);

  const consts = new Map<string, ts.Expression>();
  let props: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      consts.set(node.name.text, node.initializer);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Thing") {
      for (const argument of node.arguments ?? []) {
        if (ts.isObjectLiteralExpression(argument)) props ??= argument;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!props) throw new Error("fixture has no `new Thing({...})`");

  return collectCompositeOrigins(
    props,
    consts,
    {
      whole: new Set(scope.whole ?? []),
      destructured: new Map(Object.entries(scope.destructured ?? {})),
    },
    "WebService",
  );
}

const fromParam = (...names: string[]): PathOrigin => ({
  kind: "composite-parameter",
  composite: "WebService",
  parameters: names,
});
const fixed: PathOrigin = { kind: "composite-literal", composite: "WebService" };

describe("collectCompositeOrigins", () => {
  test("a parameter read and a fixed literal are both recorded, at their own paths", () => {
    expect(compositeOriginsOf(`return new Thing({ name: props.name, tier: "prod" });`)).toEqual({
      name: fromParam("name"),
      tier: fixed,
    });
  });

  test("a nested parameter path keeps its dots", () => {
    expect(compositeOriginsOf(`return new Thing({ path: props.iam.path });`)).toEqual({
      path: fromParam("iam.path"),
    });
  });

  test("a destructured parameter is the path it was destructured from", () => {
    expect(
      compositeOriginsOf(`return new Thing({ name: name, max: scaling.max });`, {
        destructured: { name: "name", scaling: "scaling" },
      }),
    ).toEqual({ name: fromParam("name"), max: fromParam("scaling.max") });
  });

  test("a value hoisted into a body const is still attributed", () => {
    expect(
      compositeOriginsOf("const roleName = `role-for-${props.name}`; return new Thing({ roleName });"),
    ).toEqual({ roleName: fromParam("name") });
  });

  test("a const bound to a sibling resource is NOT followed, so the field reads as fixed", () => {
    expect(
      compositeOriginsOf(`const b = new Bucket({ BucketName: props.name }); return new Thing({ ref: b.Arn });`),
    ).toEqual({ ref: fixed });
  });

  test("an object literal is descended into; an array is attributed whole", () => {
    expect(
      compositeOriginsOf(`return new Thing({ v: { Status: "Enabled" }, Tags: [{ Key: "t", Value: props.tier }] });`),
    ).toEqual({ "v.Status": fixed, Tags: fromParam("tier") });
  });

  test("a bare props reference names no single parameter", () => {
    expect(compositeOriginsOf(`return new Thing({ all: props });`)).toEqual({ all: fixed });
  });

  test("a spread records a parameter it finds and claims nothing when it finds none", () => {
    expect(compositeOriginsOf(`return new Thing({ ...props.extra, name: "n" });`)).toEqual({
      "": fromParam("extra"),
      name: fixed,
    });
    expect(compositeOriginsOf(`return new Thing({ ...defaults, name: "n" });`)).toEqual({ name: fixed });
  });

  test("a factory with no parameters at all fixes everything", () => {
    expect(compositeOriginsOf(`return new Thing({ name: "n" });`, {})).toEqual({ name: fixed });
  });

  test("a computed key is skipped rather than guessed at", () => {
    expect(compositeOriginsOf(`return new Thing({ [props.key]: 1, name: props.name });`)).toEqual({
      name: fromParam("name"),
    });
  });
});
