import { describe, test, expect } from "vitest";
import { blocksToEntities, type TerraformEntity } from "./parse";

describe("blocksToEntities: suppression attachment (chant #2111)", () => {
  test("attaches the block's start line even with no suppression comment", async () => {
    const entities = await blocksToEntities(
      [{ name: "main.tf", source: `terraform {\n  required_version = ">= 1.5.0"\n}\n` }],
      "app",
    );
    const e = entities.get("app/terraform") as TerraformEntity;
    expect(e.props.line).toBe(1);
    expect(e.suppressions).toBeUndefined();
  });

  test("a chant-ignore-block comment attaches to the block it precedes", async () => {
    const source = `# chant-ignore-block: TF001\nterraform {\n}\n`;
    const entities = await blocksToEntities([{ name: "main.tf", source }], "app");
    const e = entities.get("app/terraform") as TerraformEntity;
    expect(e.suppressions).toHaveLength(1);
    expect(e.suppressions?.[0].form).toBe("chant-ignore-block");
    expect(e.suppressions?.[0].ids).toEqual(new Set(["TF001"]));
  });

  test("a chant-ignore comment attaches identically to a resource block", async () => {
    const source = `# chant-ignore: TF999\nresource "null_resource" "x" {\n}\n`;
    const entities = await blocksToEntities([{ name: "main.tf", source }], "app");
    const e = entities.get("app/null_resource.x") as TerraformEntity;
    expect(e.suppressions?.[0].form).toBe("chant-ignore");
    expect(e.suppressions?.[0].ids).toEqual(new Set(["TF999"]));
  });

  test("a chant-ignore-file directive attaches to every entity in the file", async () => {
    const source = [
      "# chant-ignore-file: TF999",
      "terraform {",
      "}",
      "",
      'resource "null_resource" "x" {',
      "}",
    ].join("\n");
    const entities = await blocksToEntities([{ name: "main.tf", source }], "app");
    const tf = entities.get("app/terraform") as TerraformEntity;
    const res = entities.get("app/null_resource.x") as TerraformEntity;
    expect(tf.suppressions?.some((d) => d.form === "chant-ignore-file")).toBe(true);
    expect(res.suppressions?.some((d) => d.form === "chant-ignore-file")).toBe(true);
  });

  test("a misplaced chant-ignore-file is still attached, marked misplaced", async () => {
    const source = ["# a header comment", "# chant-ignore-file: TF999", 'variable "x" {', "  type = string", "}"].join("\n");
    const entities = await blocksToEntities([{ name: "main.tf", source }], "app");
    const e = entities.get("app/var.x") as TerraformEntity;
    const fileDirective = e.suppressions?.find((d) => d.form === "chant-ignore-file");
    expect(fileDirective?.misplaced).toBe(true);
  });

  test("two blocks sharing an address across files each get their own line and directive", async () => {
    const files = [
      { name: "a.tf", source: `# chant-ignore: TF010\nlocals {\n  a = 1\n}\n` },
      { name: "b.tf", source: `locals {\n  b = 2\n}\n` },
    ];
    const entities = await blocksToEntities(files, "app");
    const first = entities.get("app/locals") as TerraformEntity;
    const second = entities.get("app/locals~2") as TerraformEntity;
    expect(first.props.line).toBe(2);
    expect(first.suppressions).toHaveLength(1);
    expect(second.props.line).toBe(1);
    expect(second.suppressions).toBeUndefined();
  });
});
