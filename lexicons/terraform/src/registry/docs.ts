/**
 * The module docs extractor (chant#4598, terragucci#1289 bundle B): what a
 * module's catalog page shows, read from the module's own directory.
 *
 * {@link moduleDocs} returns the README, the inputs (type, default,
 * description, sensitivity, whether one is required), the outputs, the
 * required providers and Terraform version, and the `examples/` tree. The
 * structured fields always come from chant's own HCL parse
 * (`parseTerraformRootDir`, ../hcl/parse.ts), `.tf` and `.tf.json` alike.
 *
 * When the module carries a `.terraform-docs.yml` (or `.terraform-docs.yaml`)
 * and the caller passes a terraform-docs runner, the runner is called with
 * that file and its markdown is kept as the page's body, since the module's
 * author chose that layout. Without the file, without a runner, or when the
 * runner finds no binary or fails, the page is built from the parse alone.
 * `docsFrom` says which happened and `note` says why.
 *
 * {@link terraformCatalogFields} turns the docs into the release catalog's
 * `terraform` fields (`@intentius/chant/lifecycle/release-catalog`), and
 * {@link terraformCatalogSections} into the site's sections for a component
 * and a version.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/hcl2json";
import type { CatalogSiteSection, CatalogSiteSections } from "@intentius/chant/lifecycle/release-catalog-site";
import { OUTPUT_TYPE, TERRAFORM_TYPE, VARIABLE_TYPE, listTerraformFiles, parseTerraformRootDir, type TerraformEntity } from "../hcl/parse";

/** The terraform-docs config file names a module may carry, in the order they are looked for. */
export const TERRAFORM_DOCS_CONFIGS = [".terraform-docs.yml", ".terraform-docs.yaml"] as const;

/** One module input, a `variable` block. */
export interface ModuleInput {
  name: string;
  /** The type constraint as written, `string` or `map(object({...}))`, or null when none is declared. */
  type: string | null;
  /** True when the variable has no default. */
  required: boolean;
  /** The default as the parse reads it. Absent when required, and when the variable is sensitive. */
  default?: unknown;
  description: string | null;
  sensitive: boolean;
  /** The file that declares it. */
  file: string;
}

/** One module output. */
export interface ModuleOutput {
  name: string;
  description: string | null;
  sensitive: boolean;
  file: string;
}

/** One entry of `required_providers`. */
export interface ModuleProvider {
  name: string;
  source: string | null;
  version: string | null;
}

/** One directory under `examples/`. */
export interface ModuleExample {
  name: string;
  /** From the module's directory, `examples/<name>`. */
  path: string;
  readme: string | null;
  /** Its configuration files, sorted. */
  files: string[];
}

/** Everything a catalog page shows about one module version. */
export interface ModuleDocs {
  readme: string | null;
  inputs: ModuleInput[];
  outputs: ModuleOutput[];
  providers: ModuleProvider[];
  requiredVersion: string | null;
  examples: ModuleExample[];
  /** `terraform-docs` when the body is terraform-docs's markdown, `hcl` when the page is built from the parse alone. */
  docsFrom: "terraform-docs" | "hcl";
  /** terraform-docs's output, when `docsFrom` is `terraform-docs`. */
  markdown: string | null;
  /** The terraform-docs config file found, from the module's directory. */
  config: string | null;
  /** Why the parse was used when a config file was found. */
  note: string | null;
}

/**
 * Runs terraform-docs in `dir` with `config` (a path from `dir`) and returns
 * its markdown, or null when no terraform-docs binary is installed. Injected,
 * so a test fakes it and a product chooses how the binary is found.
 */
export type TerraformDocsRunner = (args: { dir: string; config: string }) => Promise<string | null>;

export interface ModuleDocsOptions {
  /** The HCL parser; loaded on first use when absent. */
  parser?: Hcl2Json;
  /** Runs terraform-docs when the module has a config file. Without one the parse is used. */
  terraformDocs?: TerraformDocsRunner;
  /** The binary the module is written for (`terraform`, `tofu`), which decides the files read. */
  binary?: string;
}

const README_NAMES = ["README.md", "readme.md", "Readme.md", "README"];

function readme(dir: string): string | null {
  for (const name of README_NAMES) {
    const p = join(dir, name);
    if (existsSync(p) && statSync(p).isFile()) return readFileSync(p, "utf-8");
  }
  return null;
}

/** `${string}` as hcl2json writes an expression, or `string` as a `.tf.json` file does: the expression either way. */
function expression(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^\$\{([\s\S]*)\}$/.exec(v.trim());
  return (m ? m[1]! : v).trim();
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

function firstBody(v: unknown): Record<string, unknown> | undefined {
  const b = Array.isArray(v) ? v[0] : v;
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : undefined;
}

function providersOf(body: Record<string, unknown>): ModuleProvider[] {
  const out: ModuleProvider[] = [];
  const blocks = Array.isArray(body.required_providers) ? body.required_providers : body.required_providers ? [body.required_providers] : [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    for (const [name, spec] of Object.entries(block as Record<string, unknown>)) {
      // A bare string is the old `aws = "~> 4.0"` form: a version with no source.
      if (typeof spec === "string") {
        out.push({ name, source: null, version: spec });
        continue;
      }
      const s = firstBody(spec) ?? {};
      out.push({ name, source: text(s.source), version: text(s.version) });
    }
  }
  return out;
}

function examples(dir: string, binary: string | undefined): ModuleExample[] {
  const root = join(dir, "examples");
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const path = join(root, name);
      return { name, path: `examples/${name}`, readme: readme(path), files: [...listTerraformFiles(path, binary)].sort() };
    });
}

async function fromTerraformDocs(dir: string, runner: TerraformDocsRunner | undefined): Promise<Pick<ModuleDocs, "docsFrom" | "markdown" | "config" | "note">> {
  const config = TERRAFORM_DOCS_CONFIGS.find((name) => existsSync(join(dir, name))) ?? null;
  if (!config) return { docsFrom: "hcl", markdown: null, config: null, note: null };
  if (!runner) return { docsFrom: "hcl", markdown: null, config, note: `${config} found, and no terraform-docs runner was given` };
  try {
    const markdown = await runner({ dir, config });
    if (markdown === null) return { docsFrom: "hcl", markdown: null, config, note: `${config} found, and no terraform-docs binary is installed` };
    return { docsFrom: "terraform-docs", markdown, config, note: null };
  } catch (e) {
    return { docsFrom: "hcl", markdown: null, config, note: `terraform-docs failed with ${config}: ${(e as Error).message.split("\n", 1)[0]}` };
  }
}

/**
 * Read one module's docs from `dir`. Throws what the HCL parse throws for a
 * file it cannot read; a terraform-docs failure is never thrown, it falls
 * back to the parse and says so in `note`.
 */
export async function moduleDocs(dir: string, options: ModuleDocsOptions = {}): Promise<ModuleDocs> {
  const entities = [...(await parseTerraformRootDir(dir, "module", options.parser, options.binary ? { binary: options.binary } : undefined)).values()] as TerraformEntity[];
  const inputs: ModuleInput[] = [];
  const outputs: ModuleOutput[] = [];
  const providers: ModuleProvider[] = [];
  let requiredVersion: string | null = null;
  for (const e of entities) {
    const { address, body, file } = e.props;
    if (e.entityType === VARIABLE_TYPE) {
      const sensitive = body.sensitive === true;
      const required = !("default" in body);
      inputs.push({
        name: address.slice("var.".length),
        type: expression(body.type),
        required,
        ...(!required && !sensitive ? { default: body.default } : {}),
        description: text(body.description),
        sensitive,
        file,
      });
    } else if (e.entityType === OUTPUT_TYPE) {
      outputs.push({ name: address.slice("output.".length), description: text(body.description), sensitive: body.sensitive === true, file });
    } else if (e.entityType === TERRAFORM_TYPE) {
      providers.push(...providersOf(body));
      requiredVersion ??= text(body.required_version);
    }
  }
  inputs.sort((a, b) => a.name.localeCompare(b.name));
  outputs.sort((a, b) => a.name.localeCompare(b.name));
  providers.sort((a, b) => a.name.localeCompare(b.name));
  return {
    readme: readme(dir),
    inputs,
    outputs,
    providers,
    requiredVersion,
    examples: examples(dir, options.binary),
    ...(await fromTerraformDocs(dir, options.terraformDocs)),
  };
}

/**
 * The release catalog's `terraform` fields for a module version: its
 * address (`<host>/<namespace>/<name>/<system>`), the docs' structured
 * parts, and the markdown when terraform-docs wrote it. Everything here is
 * JSON, as the catalog's schema requires.
 */
export function terraformCatalogFields(docs: ModuleDocs, address: string): Record<string, unknown> {
  return {
    address,
    inputs: docs.inputs.map(({ file: _file, ...i }) => i),
    outputs: docs.outputs.map(({ file: _file, ...o }) => o),
    providers: docs.providers,
    requiredVersion: docs.requiredVersion,
    examples: docs.examples.map((x) => ({ name: x.name, path: x.path, files: x.files })),
    docsFrom: docs.docsFrom,
    ...(docs.readme !== null ? { readme: docs.readme } : {}),
    ...(docs.markdown !== null ? { markdown: docs.markdown } : {}),
  };
}

/** The `terraform` fields as the site reads them back from the catalog. */
interface TerraformFields {
  address?: string;
  inputs?: Array<Omit<ModuleInput, "file">>;
  outputs?: Array<Omit<ModuleOutput, "file">>;
  providers?: ModuleProvider[];
  requiredVersion?: string | null;
  examples?: Array<{ name: string; path: string }>;
  readme?: string;
  markdown?: string;
}

const show = (v: unknown): string => (v === undefined ? "" : typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? "");

function versionSections(f: TerraformFields, version: string | null): CatalogSiteSection[] {
  const out: CatalogSiteSection[] = [];
  if (f.address) {
    const pin = version ? `\n  version = "${version}"` : "";
    out.push({ title: "Usage", body: { kind: "code", text: `module "${f.address.split("/").at(-2) ?? "this"}" {\n  source  = "${f.address}"${pin}\n}` } });
  }
  if (f.inputs?.length) {
    out.push({
      title: "Inputs",
      body: { kind: "table", columns: ["Name", "Type", "Default", "Required", "Description"], rows: f.inputs.map((i) => [i.name, i.type ?? "", i.sensitive ? "(sensitive)" : i.required ? "" : show(i.default), i.required ? "yes" : "no", i.description ?? ""]) },
    });
  }
  if (f.outputs?.length) {
    out.push({ title: "Outputs", body: { kind: "table", columns: ["Name", "Description", "Sensitive"], rows: f.outputs.map((o) => [o.name, o.description ?? "", o.sensitive ? "yes" : "no"]) } });
  }
  if (f.providers?.length || f.requiredVersion) {
    const rows = (f.providers ?? []).map((p) => [p.name, p.source ?? "", p.version ?? ""]);
    if (f.requiredVersion) rows.unshift(["terraform", "", f.requiredVersion]);
    out.push({ title: "Requirements", body: { kind: "table", columns: ["Name", "Source", "Version"], rows } });
  }
  if (f.examples?.length) out.push({ title: "Examples", body: { kind: "table", columns: ["Example", "Path"], rows: f.examples.map((x) => [x.name, x.path]) } });
  // terraform-docs's markdown is shown as text: the site renders no markdown, and escaping keeps a module's README from writing HTML into the page.
  const body = f.markdown ?? f.readme;
  if (body) out.push({ title: f.markdown ? "Documentation" : "README", body: { kind: "code", text: body } });
  return out;
}

/**
 * The site sections (`renderCatalogSite`'s `sections`) for Terraform
 * modules: usage, inputs, outputs, requirements, examples and the README or
 * terraform-docs's markdown on each version page, read from the version's
 * `terraform` fields, and the usage line on the component page from the
 * component's. A component without `terraform` fields gets none.
 */
export function terraformCatalogSections(): CatalogSiteSections {
  return {
    component: (c) => {
      const f = c.fields.terraform as TerraformFields | undefined;
      return f?.address ? versionSections({ address: f.address }, c.latest && !c.latest.includes(":") ? c.latest : null) : [];
    },
    version: (_c, v) => {
      const f = v.fields.terraform as TerraformFields | undefined;
      return f ? versionSections(f, v.version) : [];
    },
  };
}
