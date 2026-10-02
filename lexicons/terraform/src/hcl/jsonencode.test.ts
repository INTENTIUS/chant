import { describe, expect, test } from "vitest";
import { isUnknown, readJsonencode, UNKNOWN } from "./jsonencode";

/** What hcl2json hands back for `attr = jsonencode(<arg>)`: the source text, wrapped as one interpolation. */
const call = (arg: string): string => `\${jsonencode(${arg})}`;

describe("readJsonencode: a literal jsonencode argument read as structure (chant #2286)", () => {
  test("an IAM policy in HCL object syntax, as hcl2json renders it", () => {
    const raw =
      '${jsonencode({\n    Version = "2012-10-17"\n    Statement = [\n      {\n        Action   = ["s3:*", "ec2:Describe*"]\n' +
      '        "Effect" : "Allow"\n        Resource = "*"\n      },\n    ]\n  })}';
    expect(readJsonencode(raw)).toEqual({
      kind: "literal",
      value: {
        Version: "2012-10-17",
        Statement: [{ Action: ["s3:*", "ec2:Describe*"], Effect: "Allow", Resource: "*" }],
      },
    });
  });

  test("a container definitions tuple with commas, numbers, booleans and null", () => {
    const raw = call('[{ name = "app", cpu = 256, essential = true, memory = null, portMappings = [{ containerPort = 80 }] }]');
    expect(readJsonencode(raw)).toEqual({
      kind: "literal",
      value: [{ name: "app", cpu: 256, essential: true, memory: null, portMappings: [{ containerPort: 80 }] }],
    });
  });

  test("scalars, negative and exponent numbers, and string escapes", () => {
    expect(readJsonencode(call('"x"'))).toEqual({ kind: "literal", value: "x" });
    expect(readJsonencode(call("-1.5e2"))).toEqual({ kind: "literal", value: -150 });
    expect(readJsonencode(call('"a\\"b\\\\c\\n\\u00e9"'))).toEqual({ kind: "literal", value: 'a"b\\c\né' });
    expect(readJsonencode(call('"$${literal} %%{also}"'))).toEqual({ kind: "literal", value: "${literal} %{also}" });
  });

  test("comments inside the argument are whitespace", () => {
    const raw = call('{\n  # why\n  a = 1 // trailing\n  /* block */ b = "x"\n}');
    expect(readJsonencode(raw)).toEqual({ kind: "literal", value: { a: 1, b: "x" } });
  });

  test("spacing around the call itself", () => {
    expect(readJsonencode('${ jsonencode ( { a = 1 } ) }')).toEqual({ kind: "literal", value: { a: 1 } });
  });

  test.each([
    ["a reference as a value", '{ Resource = var.arn }', /reference/],
    ["a reference as the whole argument", "local.policy", /reference/],
    ["a function call", '{ Resource = concat(["a"], var.b) }', /function call/],
    ["a for-expression in a tuple", "[for a in var.actions : a]", /for-expression/],
    ["a for-expression in an object", "{ for k, v in var.m : k => v }", /for-expression/],
    ["a conditional", '{ Action = var.admin ? "*" : "s3:GetObject" }', /reference/],
    ["a conditional on a literal", '{ Action = true ? "*" : "x" }', /conditional/],
    ["an interpolated string", '{ Resource = "arn:aws:s3:::${var.bucket}/*" }', /interpolation/],
    ["a template directive", '{ Resource = "%{ if true }x%{ endif }" }', /directive/],
    ["an operator", "{ n = 1 + 2 }", /operator/],
    ["a computed key", '{ (var.k) = "v" }', /computed object key/],
    ["a heredoc", "<<EOT\n{}\nEOT\n", /heredoc/],
    ["an index on a literal", '{ a = ["x"][0] }', /index/],
  ])("not-determined: %s", (_name, arg, reason) => {
    const read = readJsonencode(call(arg));
    expect(read.kind).toBe("not-determined");
    if (read.kind === "not-determined") expect(read.reason).toMatch(reason);
  });

  test("not-determined: two calls in one template, never literal", () => {
    expect(readJsonencode('${jsonencode({a = 1})}-${jsonencode({b = 2})}').kind).toBe("not-determined");
  });

  test.each([
    ["a plain string", '{"Statement":[]}'],
    ["a reference", "${data.aws_iam_policy_document.x.json}"],
    ["a file() call", '${file("policy.json")}'],
    ["a templatefile() call", '${templatefile("p.tpl", { a = 1 })}'],
    ["a template around a jsonencode call", 'x-${jsonencode({a = 1})}'],
    ["a number", 3],
    ["absent", undefined],
    ["a structured value", { Statement: [] }],
  ])("not-jsonencode: %s", (_name, raw) => {
    expect(readJsonencode(raw)).toEqual({ kind: "not-jsonencode" });
  });
});

describe("readJsonencode with unknownLeaves: expressions become opaque leaves", () => {
  const leaves = (raw: string) => readJsonencode(raw, { unknownLeaves: true });

  test("a literal Action survives beside a reference Resource", () => {
    const read = leaves(call('{\n  Statement = [{\n    Action   = "*"\n    Resource = aws_s3_bucket.x.arn\n    Effect   = "Allow"\n  }]\n}'));
    expect(read.kind).toBe("literal");
    if (read.kind !== "literal") return;
    const stmt = (read.value as { Statement: Record<string, unknown>[] }).Statement[0];
    expect(stmt.Action).toBe("*");
    expect(stmt.Effect).toBe("Allow");
    expect(isUnknown(stmt.Resource)).toBe(true);
    expect((stmt.Resource as { reason: string }).reason).toMatch(/reference/);
    expect((stmt.Resource as Record<symbol, unknown>)[UNKNOWN]).toBe(true);
  });

  test("container definitions keep their literal environment beside image = var.image", () => {
    const read = leaves(
      call('[{\n  name  = "app"\n  image = "${var.repo}:${var.tag}"\n  cpu   = var.cpu * 2\n  environment = [{ name = "DB_PASSWORD", value = "hunter2" }]\n}]'),
    );
    expect(read.kind).toBe("literal");
    if (read.kind !== "literal") return;
    const def = (read.value as Record<string, unknown>[])[0];
    expect(def.name).toBe("app");
    expect(isUnknown(def.image)).toBe(true);
    expect(isUnknown(def.cpu)).toBe(true);
    expect(def.environment).toEqual([{ name: "DB_PASSWORD", value: "hunter2" }]);
  });

  test.each([
    ["a function call spanning lines", 'merge(\n  { a = "x" },\n  var.extra,\n)'],
    ["a conditional with nested literals", 'var.admin ? { a = "*" } : {}'],
    ["a heredoc", "<<EOT\n{\"a\": 1}\nEOT"],
    ["an indexed tuple", '["x"][0]'],
    ["a splat", "aws_s3_bucket.b[*].arn"],
    ["a string with nested quotes in its interpolation", '"${lookup(var.m, "k", "}")}"'],
  ])("skips %s and reads the next field", (_name, expr) => {
    const read = leaves(call(`{\n  a = ${expr}\n  b = "after"\n}`));
    expect(read.kind).toBe("literal");
    if (read.kind !== "literal") return;
    const v = read.value as Record<string, unknown>;
    expect(isUnknown(v.a)).toBe(true);
    expect(v.b).toBe("after");
  });

  test("tuple items are skipped one at a time", () => {
    const read = leaves(call('["s3:GetObject", var.extra, "*"]'));
    expect(read.kind).toBe("literal");
    if (read.kind !== "literal") return;
    const v = read.value as unknown[];
    expect(v[0]).toBe("s3:GetObject");
    expect(isUnknown(v[1])).toBe(true);
    expect(v[2]).toBe("*");
  });

  test.each([
    ["a for-expression producing the collection", "{ Statement = [for s in var.s : s] }", /for-expression/],
    ["an object for-expression", "{ for k, v in var.m : k => v }", /for-expression/],
    ["a computed key", '{ (var.k) = "v" }', /computed object key/],
    ["an interpolated key", '{ "${var.k}" = "v" }', /object key/],
    ["an expression as the whole argument", "local.policy", /reference/],
    ["a splat as the whole argument", "var.x[*]", /reference/],
  ])("still not-determined: %s", (_name, arg, reason) => {
    const read = leaves(call(arg));
    expect(read.kind).toBe("not-determined");
    if (read.kind === "not-determined") expect(read.reason).toMatch(reason);
  });

  test("the default mode is unchanged: one expression makes the whole read not-determined", () => {
    expect(readJsonencode(call('{ Action = "*", Resource = var.arn }')).kind).toBe("not-determined");
  });
});
