import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isLexiconPlugin } from "@intentius/chant/lexicon";
import { validateLexiconConfig } from "@intentius/chant/lexicon-config";
import type { ChantConfig } from "@intentius/chant/config";
import { isDeclarable, isResourceDeclarable, type Declarable } from "@intentius/chant/declarable";
import { terraformPlugin } from "./plugin";
import { terraformConfigSchema } from "./config";
import {
  DATA_TYPE,
  PROVIDER_TYPE,
  RESOURCE_TYPE,
  TERRAFORM_TYPE,
  VARIABLE_TYPE,
  parseTerraformRootContent,
} from "./hcl/parse";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

/** The `props` of a parsed entity, narrowed through the guard the checks use. */
function propsOf(entity: Declarable | undefined): Record<string, unknown> {
  if (!entity || !isResourceDeclarable(entity)) throw new Error("not a ResourceDeclarable");
  return entity.props as Record<string, unknown>;
}

/** `buildRoots` is optional on the contract; every test here needs it present. */
function buildRoots(
  projectRoot: string,
  config: Record<string, unknown>,
): Promise<{ entities: Map<string, Declarable>; warnings?: string[] }> {
  const hook = terraformPlugin.buildRoots;
  if (!hook) throw new Error("terraformPlugin.buildRoots is not registered");
  return hook({ projectRoot, config, entities: new Map() });
}

describe("terraform plugin", () => {
  it("is a valid LexiconPlugin", () => {
    expect(isLexiconPlugin(terraformPlugin)).toBe(true);
  });

  it("has the correct name", () => {
    expect(terraformPlugin.name).toBe("terraform");
  });

  it("has a serializer with the TF rule prefix", () => {
    expect(terraformPlugin.serializer.name).toBe("terraform");
    expect(terraformPlugin.serializer.rulePrefix).toBe("TF");
  });

  it("declares its config schema", () => {
    expect(terraformPlugin.configSchema).toBe(terraformConfigSchema);
  });

  it("returns at least one lint rule and one post-synth check", () => {
    expect(terraformPlugin.lintRules?.().length).toBeGreaterThan(0);
    expect(terraformPlugin.postSynthChecks?.().length).toBeGreaterThan(0);
  });

  it("registers the LSP providers and docs", () => {
    expect(typeof terraformPlugin.completionProvider).toBe("function");
    expect(typeof terraformPlugin.hoverProvider).toBe("function");
    expect(typeof terraformPlugin.docs).toBe("function");
  });
});

describe("terraform config schema", () => {
  it("accepts a root with every optional field", () => {
    const parsed = terraformConfigSchema.parse({
      binary: "tofu",
      roots: {
        app: {
          dir: "./terraform/app",
          workspace: "prod",
          varFiles: ["prod.tfvars"],
          backendConfig: { bucket: "tfstate" },
        },
      },
    });
    expect(parsed.roots.app.workspace).toBe("prod");
  });

  it("rejects an unknown key at the namespace level", () => {
    expect(() => terraformConfigSchema.parse({ roots: {}, binaries: "tofu" })).toThrow();
  });

  it("rejects an unknown key inside a root", () => {
    expect(() => terraformConfigSchema.parse({ roots: { app: { dir: ".", varfiles: [] } } })).toThrow();
  });

  it("rejects a binary that is neither terraform nor tofu", () => {
    expect(() => terraformConfigSchema.parse({ binary: "pulumi", roots: {} })).toThrow();
  });
});

describe("config load through the plugin's configSchema", () => {
  /** What `chant build` does with the namespace before anything else runs. */
  function validate(config: Record<string, unknown>): ReturnType<typeof validateLexiconConfig> {
    return validateLexiconConfig([terraformPlugin], config as unknown as ChantConfig);
  }

  it("accepts a well-formed namespace", () => {
    expect(validate({ terraform: { roots: { app: { dir: "./terraform" } } } })).toEqual([]);
  });

  // Zod 4 reports an unrecognized key at the path of the object that carries
  // it, naming the key in the message rather than in the path.
  it("fails an unknown key under terraform", () => {
    const problems = validate({ terraform: { roots: {}, workspaces: ["prod"] } });
    expect(problems).toHaveLength(1);
    expect(problems[0].path).toBe("terraform");
    expect(problems[0].lexicon).toBe("terraform");
    expect(problems[0].message).toContain("workspaces");
  });

  it("fails an unknown key inside a root", () => {
    const problems = validate({ terraform: { roots: { app: { dir: ".", varfiles: [] } } } });
    expect(problems.map((p) => p.path)).toEqual(["terraform.roots.app"]);
    expect(problems[0].message).toContain("varfiles");
  });

  it("fails a root with no dir", () => {
    const problems = validate({ terraform: { roots: { app: {} } } });
    expect(problems.map((p) => p.path)).toEqual(["terraform.roots.app.dir"]);
  });

  it("says nothing about a project that declares no terraform namespace", () => {
    expect(validate({ lexicons: ["terraform"] })).toEqual([]);
  });
});

describe("buildRoots", () => {
  it("returns one entity per block for the with-backend fixture", async () => {
    const { entities, warnings } = await buildRoots(fixtures, {
      terraform: { roots: { app: { dir: "./with-backend" } } },
    });

    expect(warnings ?? []).toEqual([]);
    expect([...entities.keys()].sort()).toEqual([
      "app/null_resource.first",
      "app/null_resource.second",
      "app/provider.null",
      "app/terraform",
    ]);

    const terraformBlock = entities.get("app/terraform")!;
    expect(terraformBlock.entityType).toBe(TERRAFORM_TYPE);
    expect(terraformBlock.lexicon).toBe("terraform");
    expect(isDeclarable(terraformBlock)).toBe(true);
    expect(isResourceDeclarable(terraformBlock)).toBe(true);

    const props = propsOf(terraformBlock);
    expect(props.address).toBe("terraform");
    expect(props.file).toBe("main.tf");
    expect(props.root).toBe("app");
    expect((props.body as Record<string, unknown>).backend).toBeDefined();

    expect(entities.get("app/provider.null")!.entityType).toBe(PROVIDER_TYPE);
    expect(entities.get("app/null_resource.first")!.entityType).toBe(RESOURCE_TYPE);
  });

  it("parses the no-backend fixture with no backend on the terraform block", async () => {
    const { entities } = await buildRoots(fixtures, {
      terraform: { roots: { legacy: { dir: "./no-backend" } } },
    });

    expect([...entities.keys()].sort()).toEqual([
      "legacy/null_resource.first",
      "legacy/null_resource.second",
      "legacy/provider.null",
      "legacy/terraform",
    ]);
    const body = propsOf(entities.get("legacy/terraform")).body as Record<string, unknown>;
    expect(body.backend).toBeUndefined();
    expect(body.required_version).toBe(">= 1.5.0");
  });

  it("keys both roots apart when they are configured together", async () => {
    const { entities } = await buildRoots(fixtures, {
      terraform: {
        roots: { app: { dir: "./with-backend" }, legacy: { dir: "./no-backend" } },
      },
    });
    expect(entities.size).toBe(8);
    expect(entities.has("app/terraform")).toBe(true);
    expect(entities.has("legacy/terraform")).toBe(true);
  });

  it("resolves a relative dir against projectRoot, not the cwd", async () => {
    const { entities, warnings } = await buildRoots(join(fixtures, "with-backend"), {
      terraform: { roots: { app: { dir: "." } } },
    });
    expect(warnings ?? []).toEqual([]);
    expect(entities.has("app/terraform")).toBe(true);
  });

  it("warns instead of throwing for a missing directory", async () => {
    const { entities, warnings } = await buildRoots(fixtures, {
      terraform: { roots: { gone: { dir: "./does-not-exist" } } },
    });
    expect(entities.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings![0]).toContain("terraform.roots.gone");
    expect(warnings![0]).toContain("directory not found");
  });

  it("keeps the other roots when one is missing", async () => {
    const { entities, warnings } = await buildRoots(fixtures, {
      terraform: { roots: { gone: { dir: "./does-not-exist" }, app: { dir: "./with-backend" } } },
    });
    expect(warnings).toHaveLength(1);
    expect(entities.has("app/terraform")).toBe(true);
  });

  it("contributes nothing when the namespace is absent", async () => {
    const { entities, warnings } = await buildRoots(fixtures, {});
    expect(entities.size).toBe(0);
    expect(warnings ?? []).toEqual([]);
  });
});

describe("parseTerraformRootContent", () => {
  it("reads the joined `# file:` bundle form chant audit produces", async () => {
    const content = [
      '# file: main.tf\nresource "null_resource" "root" {}',
      '# file: variables.tf\nvariable "region" {\n  type = string\n}',
    ].join("\n");

    const entities = await parseTerraformRootContent(content, ".");
    expect([...entities.keys()].sort()).toEqual([`./null_resource.root`, `./var.region`]);
    expect(entities.get("./var.region")!.entityType).toBe(VARIABLE_TYPE);
    expect(propsOf(entities.get("./null_resource.root")).file).toBe("main.tf");
    expect(propsOf(entities.get("./var.region")).file).toBe("variables.tf");
  });

  it("parses a bare .tf string with no marker at all", async () => {
    const entities = await parseTerraformRootContent('data "null_data_source" "d" {}', "app");
    expect(entities.get("app/data.null_data_source.d")!.entityType).toBe(DATA_TYPE);
  });

  it("numbers two blocks that share an address rather than dropping one", async () => {
    const content = "# file: a.tf\nlocals {\n  x = 1\n}\n# file: b.tf\nlocals {\n  y = 2\n}";
    const entities = await parseTerraformRootContent(content, "app");
    expect([...entities.keys()]).toEqual(["app/locals", "app/locals~2"]);
  });
});
