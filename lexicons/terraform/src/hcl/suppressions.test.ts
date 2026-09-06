import { describe, test, expect } from "vitest";
import { scanSuppressions, directivesFor } from "./suppressions";

describe("scanSuppressions: block start lines", () => {
  test("finds a bare block's start line", () => {
    const scan = scanSuppressions("main.tf", `terraform {\n  required_version = ">= 1.5.0"\n}\n`);
    expect(scan.blockLineQueues.get("terraform")).toEqual([1]);
  });

  test("finds a one-label block's start line and address", () => {
    const scan = scanSuppressions("main.tf", `variable "region" {\n  type = string\n}\n`);
    expect(scan.blockLineQueues.get("var.region")).toEqual([1]);
  });

  test("finds a two-label block's start line and address", () => {
    const scan = scanSuppressions(
      "main.tf",
      `resource "aws_s3_bucket" "assets" {\n  bucket = "x"\n}\n`,
    );
    expect(scan.blockLineQueues.get("aws_s3_bucket.assets")).toEqual([1]);
  });

  test("a data block's address is prefixed with data.", () => {
    const scan = scanSuppressions("main.tf", `data "aws_ami" "x" {\n  most_recent = true\n}\n`);
    expect(scan.blockLineQueues.get("data.aws_ami.x")).toEqual([1]);
  });

  test("ignores a nested block of the same keyword shape (brace depth)", () => {
    // `required_providers` isn't itself a tracked keyword, but its nested
    // `aws = { ... }` map must not confuse the depth counter into missing the
    // close of the outer `terraform` block.
    const scan = scanSuppressions(
      "main.tf",
      [
        "terraform {",
        "  required_providers {",
        '    aws = { source = "hashicorp/aws" }',
        "  }",
        "}",
        "",
        'variable "x" {',
        "  type = string",
        "}",
      ].join("\n"),
    );
    expect(scan.blockLineQueues.get("terraform")).toEqual([1]);
    expect(scan.blockLineQueues.get("var.x")).toEqual([7]);
  });

  test("two blocks sharing one address queue in file order", () => {
    const scan = scanSuppressions(
      "main.tf",
      ['locals {', "  a = 1", "}", "", "locals {", "  b = 2", "}"].join("\n"),
    );
    expect(scan.blockLineQueues.get("locals")).toEqual([1, 5]);
  });
});

describe("scanSuppressions: directive forms", () => {
  test("chant-ignore anchors to the very next line", () => {
    const scan = scanSuppressions("main.tf", `# chant-ignore: TF010, TF011\nvariable "x" {\n  type = string\n}\n`);
    const directives = scan.byAnchorLine.get(2);
    expect(directives).toHaveLength(1);
    expect(directives?.[0].form).toBe("chant-ignore");
    expect(directives?.[0].ids).toEqual(new Set(["TF010", "TF011"]));
  });

  test("chant-ignore-block parses distinctly from bare chant-ignore", () => {
    const scan = scanSuppressions("main.tf", `# chant-ignore-block: TF001\nterraform {\n}\n`);
    const directives = scan.byAnchorLine.get(2);
    expect(directives?.[0].form).toBe("chant-ignore-block");
    expect(directives?.[0].ids).toEqual(new Set(["TF001"]));
  });

  test('"all" is the wildcard', () => {
    const scan = scanSuppressions("main.tf", `# chant-ignore: all\nvariable "x" {\n  type = string\n}\n`);
    expect(scan.byAnchorLine.get(2)?.[0].ids).toBe("all");
  });

  test("also works with // comments", () => {
    const scan = scanSuppressions("main.tf", `// chant-ignore: TF010\nvariable "x" {\n  type = string\n}\n`);
    expect(scan.byAnchorLine.get(2)?.[0].ids).toEqual(new Set(["TF010"]));
  });

  test("an exp: term sets expiry and is excluded from the id list", () => {
    const scan = scanSuppressions("main.tf", `# chant-ignore: TF010 exp:2026-12-31\nvariable "x" {\n  type = string\n}\n`);
    const d = scan.byAnchorLine.get(2)?.[0];
    expect(d?.ids).toEqual(new Set(["TF010"]));
    expect(d?.expires).toBe("2026-12-31");
  });

  test("a comment not on the line immediately before a block has no effect on that block", () => {
    // The comment anchors to line 2 (its own line + 1); the block starts at
    // line 3 because of the blank line between them, so `directivesFor` never
    // finds a directive at the block's actual start line.
    const scan = scanSuppressions("main.tf", `# chant-ignore: TF010\n\nvariable "x" {\n  type = string\n}\n`);
    const { line, suppressions } = directivesFor(scan, "var.x");
    expect(line).toBe(3);
    expect(suppressions).toBeUndefined();
  });

  test("chant-ignore-file as the first non-blank line is not misplaced", () => {
    const scan = scanSuppressions("main.tf", `# chant-ignore-file: TF011\nvariable "x" {\n  type = string\n}\n`);
    expect(scan.fileDirective?.misplaced).toBeFalsy();
    expect(scan.fileDirective?.ids).toEqual(new Set(["TF011"]));
  });

  test("chant-ignore-file after another line is misplaced", () => {
    const scan = scanSuppressions("main.tf", `# a license header\n# chant-ignore-file: TF011\nvariable "x" {\n  type = string\n}\n`);
    expect(scan.fileDirective?.misplaced).toBe(true);
  });

  test("chant-ignore-file after leading blank lines is not misplaced (blank lines don't count)", () => {
    const scan = scanSuppressions("main.tf", `\n\n# chant-ignore-file: TF011\nvariable "x" {\n  type = string\n}\n`);
    expect(scan.fileDirective?.misplaced).toBeFalsy();
  });
});

describe("directivesFor", () => {
  test("combines an anchored directive with the file-level one, and reports the block's line", () => {
    const source = [
      "# chant-ignore-file: TF011",
      "# chant-ignore: TF010",
      'variable "x" {',
      "  type = string",
      "}",
    ].join("\n");
    const scan = scanSuppressions("main.tf", source);
    const { line, suppressions } = directivesFor(scan, "var.x");
    expect(line).toBe(3);
    expect(suppressions?.map((d) => d.form).sort()).toEqual(["chant-ignore", "chant-ignore-file"]);
  });

  test("an address with no recorded block line yields no line and no suppressions", () => {
    const scan = scanSuppressions("main.tf", `variable "x" {\n  type = string\n}\n`);
    const { line, suppressions } = directivesFor(scan, "var.y");
    expect(line).toBeUndefined();
    expect(suppressions).toBeUndefined();
  });

  test("popping the same address twice returns each recorded line once (FIFO)", () => {
    const scan = scanSuppressions("main.tf", `locals {\n  a = 1\n}\n\nlocals {\n  b = 2\n}\n`);
    expect(directivesFor(scan, "locals").line).toBe(1);
    expect(directivesFor(scan, "locals").line).toBe(5);
    expect(directivesFor(scan, "locals").line).toBeUndefined();
  });
});
