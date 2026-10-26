import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { blocksToEntities, jsonConfigTree, parseTerraformRootContent, parseTerraformRootDir, type TerraformEntity } from "./parse";
import { terraformPlugin } from "../plugin";

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

describe("Terragrunt config files (#3417)", () => {
  const files = [
    {
      name: "terragrunt.hcl",
      source: 'terraform {\n  source = "../m"\n}\ndependency "vpc" {\n  config_path = "../vpc"\n}\nremote_state {\n  backend = "s3"\n}\n',
    },
  ];

  test("terragrunt.hcl and root.hcl become Terragrunt entities, never module entities", async () => {
    const entities = await blocksToEntities(files, "unit");
    expect([...entities.values()].map((e) => e.entityType).sort()).toEqual([
      "Terraform::TerragruntConfig",
      "Terraform::TerragruntDependency",
      "Terraform::TerragruntRemoteState",
      "Terraform::TerragruntSource",
    ]);
    expect([...entities.keys()]).toContain("unit/dependency.vpc");
  });

  test("the same text under a .tf name is read as a Terraform terraform block", async () => {
    const entities = await blocksToEntities([{ name: "main.tf", source: 'terraform {\n  required_version = ">= 1.5"\n}\n' }], "unit");
    expect([...entities.values()].map((e) => e.entityType)).toEqual(["Terraform::Terraform"]);
  });
});

// ── chant#4457: `.tf.json` and `.tofu` files ───────────────────────────────

describe("configuration files beyond `.tf` (chant#4457)", () => {
  const configFiles = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__", "config-files");
  const at = (name: string): string => join(configFiles, name);

  /** What the acceptance compares: each entity's type, address, body and file. */
  const shape = (entities: Map<string, Declarable>): Record<string, { type: string; address: string; body: unknown; file: string }> =>
    Object.fromEntries(
      [...entities].map(([key, e]) => {
        const p = (e as TerraformEntity).props;
        return [key, { type: e.entityType, address: p.address, body: p.body, file: p.file }];
      }),
    );
  /** The same, with each file's suffix taken off so two syntaxes of one file compare equal. */
  const sameFile = (entities: Map<string, Declarable>, suffix: string) =>
    Object.fromEntries(Object.entries(shape(entities)).map(([k, v]) => [k, { ...v, file: v.file.replace(suffix, "") }]));

  test("a block in main.tf.json is the entity the same block in main.tf is", async () => {
    const tf = await parseTerraformRootDir(at("tf"), "app");
    const json = await parseTerraformRootDir(at("tf-json"), "app");
    expect(Object.keys(shape(json)).sort()).toEqual(["app/aws_s3_bucket.assets", "app/var.region"]);
    expect(shape(json)["app/aws_s3_bucket.assets"]).toEqual({ ...shape(tf)["app/aws_s3_bucket.assets"], file: "main.tf.json" });
    expect(sameFile(json, ".tf.json")).toEqual(sameFile(tf, ".tf"));
  });

  test("a main.tofu and a main.tofu.json root yields its entities under tofu and choudoufu", async () => {
    const tf = sameFile(await parseTerraformRootDir(at("tf"), "app"), ".tf");
    for (const binary of ["tofu", "choudoufu", "/usr/local/bin/tofu"]) {
      expect(sameFile(await parseTerraformRootDir(at("tofu"), "app", undefined, { binary }), ".tofu")).toEqual(tf);
      expect(sameFile(await parseTerraformRootDir(at("tofu-json"), "app", undefined, { binary }), ".tofu.json")).toEqual(tf);
    }
  });

  test("a terraform root, or one with no binary set, reads no .tofu file", async () => {
    expect((await parseTerraformRootDir(at("tofu"), "app", undefined, { binary: "terraform" })).size).toBe(0);
    expect((await parseTerraformRootDir(at("tofu-json"), "app")).size).toBe(0);
  });

  test("x.tofu shadows x.tf in a tofu or choudoufu root, and a terraform root reads x.tf", async () => {
    for (const binary of ["tofu", "choudoufu"]) {
      const keys = [...(await parseTerraformRootDir(at("shadow"), "app", undefined, { binary })).keys()].sort();
      expect(keys).toEqual(["app/aws_s3_bucket.from_tofu", "app/output.kept"]);
    }
    const keys = [...(await parseTerraformRootDir(at("shadow"), "app", undefined, { binary: "terraform" })).keys()].sort();
    expect(keys).toEqual(["app/aws_s3_bucket.from_tf", "app/output.kept"]);
  });

  test("a root whose only declaration is in a .tofu file builds its entities through buildRoots()", async () => {
    const hook = terraformPlugin.buildRoots!;
    const config = (binary: string) => ({ terraform: { binary, roots: { only: { dir: "tofu-only" } } } });
    const tofu = await hook({ projectRoot: configFiles, config: config("tofu"), entities: new Map() });
    expect([...tofu.entities.keys()]).toEqual(["only/aws_s3_bucket.only"]);
    expect(((tofu.entities.get("only/aws_s3_bucket.only") as TerraformEntity).props).file).toBe("main.tofu");
    const terraform = await hook({ projectRoot: configFiles, config: config("terraform"), entities: new Map() });
    expect(terraform.entities.size).toBe(0);
  });

  /** The joined form `chant audit` builds for a directory, every file behind a `# file:` line. */
  const bundle = (dir: string): string =>
    readdirSync(dir)
      .sort()
      .map((name) => `# file: ${name}\n${readFileSync(join(dir, name), "utf-8")}`)
      .join("\n");

  test("the audit path sees the entities the build path sees for each fixture", async () => {
    for (const [name, binary] of [
      ["tf", undefined],
      ["tf-json", undefined],
      ["tofu", "tofu"],
      ["tofu-json", "tofu"],
      ["tofu-only", "choudoufu"],
      ["shadow", "tofu"],
      ["shadow", "terraform"],
    ] as const) {
      const opts = binary ? { binary } : undefined;
      const built = shape(await parseTerraformRootDir(at(name), "app", undefined, opts));
      const audited = shape(await parseTerraformRootContent(bundle(at(name)), "app", undefined, opts));
      expect(audited).toEqual(built);
    }
  });

  test("the audit hook reads a root carrying a .tofu file as a tofu root", async () => {
    const entities = await terraformPlugin.auditEntities!(bundle(at("shadow")));
    expect([...entities.keys()].sort()).toEqual(["audit-root/aws_s3_bucket.from_tofu", "audit-root/output.kept"]);
  });
});

describe("jsonConfigTree: Terraform's JSON syntax in hcl2json's shape (chant#4457)", () => {
  test("wraps each block body in an array, one object level per label", () => {
    const tree = jsonConfigTree(
      JSON.stringify({
        "//": "a comment Terraform ignores",
        terraform: { required_version: ">= 1.5", backend: { s3: { bucket: "b", key: "k" } }, required_providers: { aws: { source: "hashicorp/aws" } } },
        locals: { a: 1 },
        provider: { aws: [{ region: "us-east-1" }, { alias: "west", region: "us-west-2" }] },
        resource: { aws_instance: { web: { ami: "x", lifecycle: { create_before_destroy: true } } } },
        data: { aws_ami: { ubuntu: { most_recent: true } } },
      }),
    );
    expect(tree).toEqual({
      terraform: [{ required_version: ">= 1.5", backend: { s3: [{ bucket: "b", key: "k" }] }, required_providers: [{ aws: { source: "hashicorp/aws" } }] }],
      locals: [{ a: 1 }],
      provider: { aws: [{ region: "us-east-1" }, { alias: "west", region: "us-west-2" }] },
      resource: { aws_instance: { web: [{ ami: "x", lifecycle: [{ create_before_destroy: true }] }] } },
      data: { aws_ami: { ubuntu: [{ most_recent: true }] } },
    });
  });

  test("a live block in a .tf.json terraform block declares the estate", async () => {
    const source = JSON.stringify({ terraform: { live: { estate: "prod" } } });
    const entities = await blocksToEntities([{ name: "main.tf.json", source }], "app", undefined, { binary: "choudoufu" });
    const live = entities.get("app/live") as TerraformEntity;
    expect(live.props.mode).toBe("live");
    expect(live.props.estate).toBe("prod");
  });

  test("a bare expression JSON writes in a string reads as hcl2json writes the expression", () => {
    const tree = jsonConfigTree(
      JSON.stringify({
        variable: { region: { type: "string" } },
        resource: { aws_instance: { web: { provider: "aws.west", depends_on: ["aws_vpc.main"], ami: "${var.ami}" } } },
      }),
    );
    expect(tree.variable).toEqual({ region: [{ type: "${string}" }] });
    expect(tree.resource).toEqual({ aws_instance: { web: [{ provider: "${aws.west}", depends_on: ["${aws_vpc.main}"], ami: "${var.ami}" }] } });
  });

  test("malformed JSON throws, as malformed HCL does", () => {
    expect(() => jsonConfigTree("{ not json")).toThrow();
  });
});
