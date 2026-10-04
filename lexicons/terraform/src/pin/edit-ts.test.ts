import { describe, expect, test } from "vitest";
import { editPinsInTs } from "./edit-ts";

const OCI = "oci://registry.example.com/modules/vpc";

describe("editPinsInTs (#3189)", () => {
  test("moves the pin in a module declaration and leaves every other byte", () => {
    const before = [
      `// source: "${OCI}?tag=1.3.0" in a comment is not a declaration`,
      `export const vpc = module("vpc", {`,
      `  source: '${OCI}?tag=1.3.0',`,
      `  cidr: "10.0.0.0/16",`,
      `});`,
      `export const registry = new TerraformModule({ source: "app.terraform.io/acme/vpc/aws", version: "= 1.3.0" });`,
      `export const other = module("dns", { source: "${OCI.replace("vpc", "dns")}?tag=1.3.0" });`,
      ``,
    ].join("\n");
    const after = editPinsInTs(before, "infra/vpc.ts", { module: OCI, from: "1.3.0", to: "1.4.0" });
    expect(after.content).toBe(before.replace(`'${OCI}?tag=1.3.0'`, `'${OCI}?tag=1.4.0'`));
    expect(after.calls).toMatchObject([{ outcome: "moved", file: "infra/vpc.ts", call: "line 2" }]);

    const registry = editPinsInTs(before, "infra/vpc.ts", { module: "app.terraform.io/acme/vpc/aws", from: "1.3.0", to: "1.4.0" });
    expect(registry.content).toBe(before.replace(`version: "= 1.3.0"`, `version: "= 1.4.0"`));
  });

  test("refuses a floating constraint with its reason", () => {
    const before = `export const m = { source: "app.terraform.io/acme/vpc/aws", version: "~> 1.3" };\n`;
    const result = editPinsInTs(before, "m.ts", { module: "app.terraform.io/acme/vpc/aws", from: "1.3.0", to: "1.4.0" });
    expect(result.content).toBe(before);
    expect(result.calls).toMatchObject([{ outcome: "refused", reason: expect.stringMatching(/is a constraint, not a pin/) }]);
  });

  test("refuses a version built from an expression", () => {
    const before = `const v = "1.3.0";\nexport const m = { source: "app.terraform.io/acme/vpc/aws", version: v };\n`;
    const result = editPinsInTs(before, "m.ts", { module: "app.terraform.io/acme/vpc/aws", from: "1.3.0", to: "1.4.0" });
    expect(result.content).toBe(before);
    expect(result.calls).toMatchObject([{ outcome: "refused", reason: expect.stringMatching(/expression/) }]);
  });
});
