/**
 * The module docs extractor (chant#4598): a module without a terraform-docs
 * config, one with it (runner faked: found, no binary, failing, and no
 * runner at all), one written as `.tf.json`, and one with `examples/`; then
 * the catalog fields and site sections built from them.
 */
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildReleaseCatalog } from "@intentius/chant/lifecycle/release-catalog";
import { renderCatalogSite } from "@intentius/chant/lifecycle/release-catalog-site";
import { moduleDocs, terraformCatalogFields, terraformCatalogSections, type TerraformDocsRunner } from "./docs";

const FIXTURES = join(import.meta.dirname, "__fixtures__", "docs");

describe("moduleDocs without a terraform-docs config", () => {
  test("reads inputs, outputs, providers and the README from the HCL", async () => {
    const docs = await moduleDocs(join(FIXTURES, "vpc"));
    expect(docs.docsFrom).toBe("hcl");
    expect(docs.config).toBeNull();
    expect(docs.note).toBeNull();
    expect(docs.markdown).toBeNull();
    expect(docs.readme).toContain("A VPC with flow logs.");
    expect(docs.inputs).toEqual([
      { name: "cidr", type: "string", required: true, description: "The VPC's IPv4 CIDR block.", sensitive: false, file: "variables.tf" },
      { name: "flow_log_key", type: "string", required: false, description: null, sensitive: true, file: "variables.tf" },
      { name: "tags", type: "map(string)", required: false, default: {}, description: "Tags for every resource.", sensitive: false, file: "variables.tf" },
    ]);
    expect(docs.outputs).toEqual([
      { name: "arn", description: null, sensitive: true, file: "outputs.tf" },
      { name: "vpc_id", description: "The VPC's id.", sensitive: false, file: "outputs.tf" },
    ]);
    expect(docs.providers).toEqual([{ name: "aws", source: "hashicorp/aws", version: ">= 5.0" }]);
    expect(docs.requiredVersion).toBe(">= 1.5");
  });

  test("never carries a sensitive default", async () => {
    const docs = await moduleDocs(join(FIXTURES, "vpc"));
    expect(JSON.stringify(docs)).not.toContain("not-a-real-key");
  });

  test("a runner is not called when the module has no config", async () => {
    let called = false;
    const docs = await moduleDocs(join(FIXTURES, "vpc"), { terraformDocs: async () => ((called = true), "x") });
    expect(called).toBe(false);
    expect(docs.docsFrom).toBe("hcl");
  });
});

describe("moduleDocs with examples/", () => {
  test("lists each example with its README and files", async () => {
    const docs = await moduleDocs(join(FIXTURES, "vpc"));
    expect(docs.examples).toEqual([
      { name: "complete", path: "examples/complete", readme: null, files: ["main.tf"] },
      { name: "simple", path: "examples/simple", readme: "# Simple\n", files: ["main.tf"] },
    ]);
  });
});

describe("moduleDocs with a .terraform-docs.yml", () => {
  const dir = join(FIXTURES, "documented");

  test("runs terraform-docs with that file and keeps its markdown", async () => {
    const calls: Array<{ dir: string; config: string }> = [];
    const runner: TerraformDocsRunner = async (args) => {
      calls.push(args);
      return "## Inputs\n\n| Name | Type |\n|---|---|\n| name | string |\n";
    };
    const docs = await moduleDocs(dir, { terraformDocs: runner });
    expect(calls).toEqual([{ dir, config: ".terraform-docs.yml" }]);
    expect(docs.docsFrom).toBe("terraform-docs");
    expect(docs.markdown).toContain("| name | string |");
    expect(docs.config).toBe(".terraform-docs.yml");
    expect(docs.inputs.map((i) => i.name)).toEqual(["name"]);
  });

  test("falls back to the HCL when the binary is missing, and says so", async () => {
    const docs = await moduleDocs(dir, { terraformDocs: async () => null });
    expect(docs.docsFrom).toBe("hcl");
    expect(docs.markdown).toBeNull();
    expect(docs.note).toBe(".terraform-docs.yml found, and no terraform-docs binary is installed");
    expect(docs.inputs.map((i) => i.name)).toEqual(["name"]);
  });

  test("falls back when the runner fails", async () => {
    const docs = await moduleDocs(dir, { terraformDocs: async () => { throw new Error("exit 1: bad config\nmore"); } });
    expect(docs.docsFrom).toBe("hcl");
    expect(docs.note).toBe("terraform-docs failed with .terraform-docs.yml: exit 1: bad config");
  });

  test("falls back when no runner is given", async () => {
    const docs = await moduleDocs(dir);
    expect(docs.docsFrom).toBe("hcl");
    expect(docs.note).toBe(".terraform-docs.yml found, and no terraform-docs runner was given");
  });
});

describe("moduleDocs on .tf.json files", () => {
  test("reads the JSON syntax the same way", async () => {
    const docs = await moduleDocs(join(FIXTURES, "json"));
    expect(docs.inputs).toEqual([
      { name: "project", type: "string", required: true, description: "The project id.", sensitive: false, file: "main.tf.json" },
      { name: "region", type: "string", required: false, default: "us-central1", description: null, sensitive: false, file: "main.tf.json" },
    ]);
    expect(docs.outputs).toEqual([{ name: "name", description: "The project id, echoed.", sensitive: false, file: "main.tf.json" }]);
    expect(docs.providers).toEqual([{ name: "google", source: "hashicorp/google", version: "~> 6.0" }]);
    expect(docs.readme).toBeNull();
    expect(docs.examples).toEqual([]);
  });
});

describe("terraformCatalogFields and terraformCatalogSections", () => {
  test("fill the catalog's terraform key and render on the version page", async () => {
    const docs = await moduleDocs(join(FIXTURES, "vpc"));
    const address = "registry.acme.dev/acme/vpc/aws";
    const fields = terraformCatalogFields(docs, address);
    expect(fields).toMatchObject({ address, docsFrom: "hcl", requiredVersion: ">= 1.5" });
    expect((fields.inputs as Array<Record<string, unknown>>)[0]).not.toHaveProperty("file");

    const catalog = buildReleaseCatalog(
      {
        releases: [{ version: 1, component: "acme/vpc/aws", env: "registry", digest: "sha256:v1", releaseVersion: "1.2.0", gitSha: "a".repeat(40), runId: "r", timestamp: "2026-10-01T00:00:00.000Z", actor: "ci" }],
        fields: [
          { component: "acme/vpc/aws", engine: "terraform", fields: { address } },
          { component: "acme/vpc/aws", version: "1.2.0", engine: "terraform", fields },
        ],
      },
      { generatedAt: "2026-10-27T00:00:00.000Z" },
    );
    const files = renderCatalogSite(catalog, terraformCatalogSections());
    const page = new TextDecoder().decode(files.find((f) => f.path === "acme/vpc/aws/1.2.0/index.html")!.bytes);
    expect(page).toContain("<h2>Inputs</h2>");
    expect(page).toContain("<td>tags</td><td>map(string)</td><td>{}</td><td>no</td>");
    expect(page).toContain("<td>flow_log_key</td><td>string</td><td>(sensitive)</td>");
    expect(page).toContain("version = &quot;1.2.0&quot;");
    expect(page).toContain("<h2>Requirements</h2>");
    expect(page).toContain("<td>hashicorp/aws</td>");
    const component = new TextDecoder().decode(files.find((f) => f.path === "acme/vpc/aws/index.html")!.bytes);
    expect(component).toContain("source  = &quot;registry.acme.dev/acme/vpc/aws&quot;");
  });
});
