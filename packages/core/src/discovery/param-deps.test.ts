import * as ts from "typescript";
import { describe, expect, test } from "vitest";
import { collectConsts } from "../fold/fold";
import {
  argumentLocation,
  collectCompositeOrigins,
  collectParamDependencies,
  collectTagOrigins,
  type CompositeCallSite,
} from "./param-deps";
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

/**
 * chant #3212 — the same join for a registered tag. The fixture body ends in
 * `return table\`...\``; `fields` stands in for what the tag reports per
 * interpolation, and `props` for the entity it built.
 */
function tagOriginsOf(body: string, fields: string[][], props: Record<string, unknown>): Record<string, PathOrigin> {
  const file = ts.createSourceFile("factory.ts", `const f = (props) => { ${body} };`, ts.ScriptTarget.Latest, true);
  const consts = new Map<string, ts.Expression>();
  let tagged: ts.TaggedTemplateExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      consts.set(node.name.text, node.initializer);
    }
    if (ts.isReturnStatement(node) && node.expression && ts.isTaggedTemplateExpression(node.expression)) {
      tagged = node.expression;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!tagged || !ts.isTemplateExpression(tagged.template)) throw new Error("fixture returns no interpolated tag");
  return collectTagOrigins(
    tagged.template.templateSpans.map((span) => span.expression),
    fields,
    props,
    consts,
    { whole: new Set(["props"]), destructured: new Map() },
    "WebService",
  );
}

describe("collectTagOrigins", () => {
  test("a field an interpolation fed is that interpolation's parameters; every other key is fixed", () => {
    expect(
      tagOriginsOf(
        "return table`CREATE TABLE ${props.name} ENGINE = MergeTree TTL ts + INTERVAL ${props.ttl.days} DAY`;",
        [["name", "ddl"], ["ttl", "ddl"]],
        { name: "t", engine: "MergeTree", ttl: "ts + INTERVAL 30 DAY", ddl: "...", absent: undefined },
      ),
    ).toEqual({
      name: fromParam("name"),
      ttl: fromParam("ttl.days"),
      ddl: fromParam("name", "ttl.days"),
      engine: fixed,
    });
  });

  test("a body const is followed, a sibling entity is not, and an interpolation reading no parameter adds nothing", () => {
    expect(
      tagOriginsOf(
        "const base = `${props.name}_daily`; const events = new Thing({}); return table`CREATE TABLE ${base} ENGINE = ${\"Summing\"} COMMENT ${events}`;",
        [["name"], ["engine"], ["comment"]],
        { name: "t_daily", engine: "Summing", comment: "events" },
      ),
    ).toEqual({ name: fromParam("name"), engine: fixed, comment: fixed });
  });

  test("a parameter recorded under a key outranks the key's fixed record", () => {
    expect(
      tagOriginsOf("return table`ENGINE = Replacing(${props.version})`;", [["engine.args"]], {
        engine: { name: "Replacing", args: ["v"] },
      }),
    ).toEqual({ "engine.args": fromParam("version"), engine: fixed });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// chant #3597 — where the argument behind a parameter was written.
// ─────────────────────────────────────────────────────────────────────────

/** The first call expression in `source`, as a call site in `/p/src/app.ts`. */
function callSiteOf(source: string): CompositeCallSite {
  const file = ts.createSourceFile("/p/src/app.ts", source, ts.ScriptTarget.Latest, true);
  let node: ts.CallExpression | undefined;
  const visit = (n: ts.Node): void => {
    if (!node && ts.isCallExpression(n)) node = n;
    ts.forEachChild(n, visit);
  };
  visit(file);
  if (!node) throw new Error("fixture has no call");
  return { file: "/p/src/app.ts", node };
}

describe("argumentLocation (#3597)", () => {
  const source = [
    'import { WebApp } from "./web-app";',
    "",
    "export const web = WebApp({",
    '  name: "web-app",',
    "  replicas: 3,",
    '  iam: { path: "/service/" },',
    "  port,",
    "});",
  ].join("\n");

  test("a top-level argument is the property as written, on its own line", () => {
    expect(argumentLocation(callSiteOf(source), "replicas")).toEqual({
      parameter: "replicas",
      file: "/p/src/app.ts",
      line: 5,
      column: 3,
      text: "replicas: 3",
    });
  });

  test("a nested parameter path descends the argument's object literals", () => {
    expect(argumentLocation(callSiteOf(source), "iam.path")).toEqual({
      parameter: "iam.path",
      file: "/p/src/app.ts",
      line: 6,
      column: 10,
      text: 'path: "/service/"',
    });
  });

  test("a shorthand property is written as its name", () => {
    expect(argumentLocation(callSiteOf(source), "port")).toMatchObject({ line: 7, column: 3, text: "port" });
  });

  test("a parameter the call leaves out falls back to the call, and claims no text", () => {
    expect(argumentLocation(callSiteOf(source), "image")).toEqual({
      parameter: "image",
      file: "/p/src/app.ts",
      line: 3,
      column: 20,
    });
    expect(argumentLocation(callSiteOf(source), "iam.role")).not.toHaveProperty("text");
  });

  test("an argument that is not an object literal falls back to the call", () => {
    const location = argumentLocation(callSiteOf("export const web = WebApp(shared);"), "replicas");
    expect(location).toEqual({ parameter: "replicas", file: "/p/src/app.ts", line: 1, column: 20 });
  });

  test("collectCompositeOrigins records the locations in the same pass, in parameter order", () => {
    const call = callSiteOf(source);
    const body = ts.createSourceFile(
      "factory.ts",
      "const f = (props) => new Thing({ spec: { replicas: props.replicas }, label: `${props.name}-${props.iam.path}`, kind: \"web\" });",
      ts.ScriptTarget.Latest,
      true,
    );
    let props: ts.ObjectLiteralExpression | undefined;
    const visit = (n: ts.Node): void => {
      if (!props && ts.isNewExpression(n)) props = n.arguments?.find(ts.isObjectLiteralExpression);
      ts.forEachChild(n, visit);
    };
    visit(body);
    const origins = collectCompositeOrigins(
      props as ts.ObjectLiteralExpression,
      new Map(),
      { whole: new Set(["props"]), destructured: new Map() },
      "WebApp",
      call,
    );
    expect(origins["spec.replicas"]).toEqual({
      kind: "composite-parameter",
      composite: "WebApp",
      parameters: ["replicas"],
      arguments: [{ parameter: "replicas", file: "/p/src/app.ts", line: 5, column: 3, text: "replicas: 3" }],
    });
    expect(origins.label).toMatchObject({
      parameters: ["iam.path", "name"],
      arguments: [
        { parameter: "iam.path", line: 6, text: 'path: "/service/"' },
        { parameter: "name", line: 4, text: 'name: "web-app"' },
      ],
    });
    // A literal carries no location: nothing at the call moves it.
    expect(origins.kind).toEqual({ kind: "composite-literal", composite: "WebApp" });
  });

  test("without a call site the origins are what they were", () => {
    expect(compositeOriginsOf("return new Thing({ replicas: props.replicas });")).toEqual({
      replicas: { kind: "composite-parameter", composite: "WebService", parameters: ["replicas"] },
    });
  });
});
