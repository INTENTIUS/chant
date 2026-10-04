import { describe, expect, test } from "vitest";
import { loadHcl2json } from "@intentius/chant/terraform/parse";
import { editPins, type PinRequest } from "./edit";
import { readModulePin } from "./source";

const parser = await loadHcl2json();

const OCI = "oci://registry.example.com/modules/vpc";
const REGISTRY = "app.terraform.io/acme/vpc/aws";
const GIT = "git::https://github.com/acme/modules.git//vpc";

/**
 * One row: a file, the request, and the whole file the edit must produce. The
 * expected text is the entire file, so every row also proves the bytes around
 * the pin are untouched: comments, heredocs, other modules, spacing.
 */
interface Row {
  name: string;
  file: string;
  request: PinRequest;
  before: string;
  after: string;
  outcomes: string[];
  reason?: RegExp;
}

const ROWS: Row[] = [
  {
    name: "an oci tag",
    file: "main.tf",
    request: { module: OCI, from: "1.3.0", to: "1.4.0" },
    before: `module "vpc" {\n  source = "${OCI}?tag=1.3.0"\n  cidr   = "10.0.0.0/16"\n}\n`,
    after: `module "vpc" {\n  source = "${OCI}?tag=1.4.0"\n  cidr   = "10.0.0.0/16"\n}\n`,
    outcomes: ["moved"],
  },
  {
    name: "an oci digest",
    file: "main.tf",
    request: { module: OCI, from: `sha256:${"a".repeat(64)}`, to: `sha256:${"b".repeat(64)}` },
    before: `module "vpc" {\n  source = "${OCI}?digest=sha256:${"a".repeat(64)}"\n}\n`,
    after: `module "vpc" {\n  source = "${OCI}?digest=sha256:${"b".repeat(64)}"\n}\n`,
    outcomes: ["moved"],
  },
  {
    name: "an oci tag moved to a digest changes the argument",
    file: "main.tf",
    request: { module: OCI, from: "1.3.0", to: `sha256:${"c".repeat(64)}` },
    before: `module "vpc" { source = "${OCI}?tag=1.3.0" }\n`,
    after: `module "vpc" { source = "${OCI}?digest=sha256:${"c".repeat(64)}" }\n`,
    outcomes: ["moved"],
  },
  {
    name: "a git ref, with comments and other modules left byte for byte",
    file: "main.tf",
    request: { module: GIT, from: "v1.3.0", to: "v1.4.0" },
    before: [
      `# source = "${GIT}?ref=v1.3.0" in a comment is not a call`,
      `module "vpc" {`,
      `  source = "${GIT}?ref=v1.3.0" # pinned`,
      `  /* version = "1.3.0" */`,
      `  tags = { note = "source = \\"${GIT}?ref=v1.3.0\\"" }`,
      `}`,
      ``,
      `module "other" {`,
      `  source = "${GIT.replace("vpc", "dns")}?ref=v1.3.0"`,
      `}`,
      ``,
    ].join("\n"),
    after: [
      `# source = "${GIT}?ref=v1.3.0" in a comment is not a call`,
      `module "vpc" {`,
      `  source = "${GIT}?ref=v1.4.0" # pinned`,
      `  /* version = "1.3.0" */`,
      `  tags = { note = "source = \\"${GIT}?ref=v1.3.0\\"" }`,
      `}`,
      ``,
      `module "other" {`,
      `  source = "${GIT.replace("vpc", "dns")}?ref=v1.3.0"`,
      `}`,
      ``,
    ].join("\n"),
    outcomes: ["moved"],
  },
  {
    name: "an exact registry version, and a second call of the same module",
    file: "main.tf",
    request: { module: REGISTRY, from: "1.3.0", to: "1.4.0" },
    before: `module "a" {\n  source  = "${REGISTRY}"\n  version = "1.3.0"\n}\n\nmodule "b" {\n  source  = "${REGISTRY}"\n  version = "= 1.3.0"\n  description = <<EOT\nversion = "1.3.0"\nEOT\n}\n`,
    after: `module "a" {\n  source  = "${REGISTRY}"\n  version = "1.4.0"\n}\n\nmodule "b" {\n  source  = "${REGISTRY}"\n  version = "= 1.4.0"\n  description = <<EOT\nversion = "1.3.0"\nEOT\n}\n`,
    outcomes: ["moved", "moved"],
  },
  {
    name: "a terragrunt source with ?ref=",
    file: "live/prod/vpc/terragrunt.hcl",
    request: { module: GIT, from: "v1.3.0", to: "v1.4.0" },
    before: `include "root" {\n  path = find_in_parent_folders()\n}\n\nterraform {\n  source = "${GIT}?ref=v1.3.0"\n}\n\ninputs = {\n  name = "vpc"\n}\n`,
    after: `include "root" {\n  path = find_in_parent_folders()\n}\n\nterraform {\n  source = "${GIT}?ref=v1.4.0"\n}\n\ninputs = {\n  name = "vpc"\n}\n`,
    outcomes: ["moved"],
  },
  {
    name: "a terragrunt tfr source with ?version=",
    file: "terragrunt.hcl",
    request: { module: "tfr:///terraform-aws-modules/vpc/aws", from: "5.1.0", to: "5.2.0" },
    before: `terraform {\n  source = "tfr:///terraform-aws-modules/vpc/aws?version=5.1.0"\n}\n`,
    after: `terraform {\n  source = "tfr:///terraform-aws-modules/vpc/aws?version=5.2.0"\n}\n`,
    outcomes: ["moved"],
  },
  {
    name: "a terragrunt oci source",
    file: "terragrunt.hcl",
    request: { module: OCI, from: "1.3.0", to: "1.4.0" },
    before: `terraform { source = "${OCI}?tag=1.3.0" }\n`,
    after: `terraform { source = "${OCI}?tag=1.4.0" }\n`,
    outcomes: ["moved"],
  },
  {
    name: "a floating constraint is refused with its reason",
    file: "main.tf",
    request: { module: REGISTRY, from: "1.3.0", to: "1.4.0" },
    before: `module "a" {\n  source  = "${REGISTRY}"\n  version = "~> 1.3"\n}\n`,
    after: `module "a" {\n  source  = "${REGISTRY}"\n  version = "~> 1.3"\n}\n`,
    outcomes: ["refused"],
    reason: /version "~> 1.3" is a constraint, not a pin/,
  },
  {
    name: "a comma-separated range is refused",
    file: "main.tf",
    request: { module: REGISTRY, from: "1.3.0", to: "1.4.0" },
    before: `module "a" {\n  source  = "${REGISTRY}"\n  version = ">= 1.3.0, < 2.0.0"\n}\n`,
    after: `module "a" {\n  source  = "${REGISTRY}"\n  version = ">= 1.3.0, < 2.0.0"\n}\n`,
    outcomes: ["refused"],
    reason: /is a constraint, not a pin/,
  },
  {
    name: "an unpinned oci source is refused",
    file: "main.tf",
    request: { module: OCI, from: "1.3.0", to: "1.4.0" },
    before: `module "vpc" {\n  source = "${OCI}"\n}\n`,
    after: `module "vpc" {\n  source = "${OCI}"\n}\n`,
    outcomes: ["refused"],
    reason: /names no tag or digest/,
  },
  {
    name: "a terragrunt source built from an expression is refused",
    file: "terragrunt.hcl",
    request: { module: GIT, from: "v1.3.0", to: "v1.4.0" },
    before: `locals {\n  ref = "v1.3.0"\n}\nterraform {\n  source = "${GIT}?ref=\${local.ref}"\n}\n`,
    after: `locals {\n  ref = "v1.3.0"\n}\nterraform {\n  source = "${GIT}?ref=\${local.ref}"\n}\n`,
    outcomes: ["refused"],
    reason: /is an expression/,
  },
  {
    name: "a call at the new version already is reported and left",
    file: "main.tf",
    request: { module: OCI, from: "1.3.0", to: "1.4.0" },
    before: `module "vpc" {\n  source = "${OCI}?tag=1.4.0"\n}\n`,
    after: `module "vpc" {\n  source = "${OCI}?tag=1.4.0"\n}\n`,
    outcomes: ["already"],
  },
  {
    name: "a call pinned at a third version is reported and left",
    file: "main.tf",
    request: { module: OCI, from: "1.3.0", to: "1.4.0" },
    before: `module "vpc" {\n  source = "${OCI}?tag=1.2.0"\n}\n`,
    after: `module "vpc" {\n  source = "${OCI}?tag=1.2.0"\n}\n`,
    outcomes: ["elsewhere"],
  },
];

describe("editPins (#3189)", () => {
  test.each(ROWS)("$name", async (row) => {
    const result = await editPins(row.before, row.file, row.request, parser);
    expect(result.content).toBe(row.after);
    expect(result.calls.map((c) => c.outcome)).toEqual(row.outcomes);
    if (row.reason) {
      const refused = result.calls.find((c) => c.outcome === "refused");
      expect(refused && "reason" in refused ? refused.reason : "").toMatch(row.reason);
    }
  });
});

describe("readModulePin", () => {
  test.each([
    [`${OCI}?tag=1.3.0`, undefined, { module: OCI, pin: "1.3.0", param: "tag" }],
    [`oci://localhost:4890/largeset/shared?tag=1.0.0`, undefined, { module: "oci://localhost:4890/largeset/shared", pin: "1.0.0", param: "tag" }],
    [`${GIT}?depth=1&ref=v2`, undefined, { module: `${GIT}?depth=1`, pin: "v2", param: "ref" }],
    [REGISTRY, "1.3.0", { module: REGISTRY, pin: "1.3.0", at: "version" }],
    [REGISTRY, "= v1.3.0", { module: REGISTRY, pin: "v1.3.0", at: "version" }],
    [REGISTRY, "~> 1.3", { module: REGISTRY, pin: null }],
    [REGISTRY, ">= 1.3", { module: REGISTRY, pin: null }],
    [REGISTRY, undefined, { module: REGISTRY, pin: null }],
    [REGISTRY, "${var.vpc_version}", { module: REGISTRY, pin: null, unpinned: expect.stringContaining("is an expression") }],
    [GIT, undefined, { module: GIT, pin: null }],
    ["./modules/vpc", undefined, { module: "./modules/vpc", pin: null }],
    [`${OCI}?tag=1&digest=sha256:${"a".repeat(64)}`, undefined, { module: OCI, pin: null }],
  ] as const)("%s %s", (source, version, want) => {
    expect(readModulePin(source, version)).toMatchObject(want);
  });
});
