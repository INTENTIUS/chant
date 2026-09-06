/**
 * The one shared HCL parse for the terraform lexicon.
 *
 * Two entry points, one entity shape. `parseTerraformRootDir` reads the `.tf`
 * files of a directory (non-recursive, matching Terraform's own module
 * scoping) and is what `buildRoots()` calls. `parseTerraformRootContent` takes
 * the joined-file string `chant audit` hands a lexicon for a discovered root
 * module: every `.tf` in filename order behind a `# file: <name>` line comment.
 * Both funnel through `blocksToEntities`, so an entity the audit path sees is
 * the entity the build path sees.
 *
 * Core owns the parser glue: `loadHcl2json()` lazy-loads `@cdktf/hcl2json`
 * (a ~1.8 MB wasm blob) and raises a one-line install hint when it is absent.
 * `parseTerraformDir()` next to it is NOT reused: it returns carve's `TfGraph`,
 * a scoring-and-excision shape with no room for the per-block bodies a
 * serializer and the post-synth checks read. The import path is the wildcard
 * core's exports map already carries (`"./*"` to `./src/*.ts`), so nothing
 * changed in `packages/core/package.json` for this.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadHcl2json, type Hcl2Json } from "@intentius/chant/terraform/parse";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";

/** A parsed HCL block body, as `@cdktf/hcl2json` encodes it. */
export type BlockBody = Record<string, unknown>;

/** The entity every block becomes. `props` is what post-synth checks read. */
export interface TerraformEntity extends Declarable {
  readonly lexicon: "terraform";
  readonly kind: "resource";
  readonly props: {
    /** Terraform address, e.g. `aws_s3_bucket.assets`, `var.region`, `module.cdn`. */
    readonly address: string;
    /** The block body, verbatim from hcl2json (interpolations survive as `"${...}"`). */
    readonly body: BlockBody;
    /** File the block came from, as named by the parse input. */
    readonly file: string;
    /** Configured root name this block belongs to. */
    readonly root: string;
  };
}

/** `entityType` per block kind. */
export const TERRAFORM_TYPE = "Terraform::Terraform";
export const PROVIDER_TYPE = "Terraform::Provider";
export const RESOURCE_TYPE = "Terraform::Resource";
export const DATA_TYPE = "Terraform::Data";
export const MODULE_TYPE = "Terraform::Module";
export const VARIABLE_TYPE = "Terraform::Variable";
export const OUTPUT_TYPE = "Terraform::Output";
export const LOCALS_TYPE = "Terraform::Locals";

/**
 * Build one entity. Written out rather than run through `createResource`
 * from `@intentius/chant/runtime`: that factory is for generated resource
 * classes and hides `props` behind a non-enumerable descriptor plus an
 * `attrMap` of `AttrRef`s this lexicon has nothing to put in. The literal
 * carries the same marker, so `isDeclarable()` and `isResourceDeclarable()`
 * both hold.
 */
export function terraformEntity(
  entityType: string,
  address: string,
  body: BlockBody,
  file: string,
  root: string,
): TerraformEntity {
  return {
    [DECLARABLE_MARKER]: true,
    lexicon: "terraform",
    entityType,
    kind: "resource",
    props: { address, body, file, root },
  };
}

/** One `.tf` file's name and source. */
export interface TerraformFile {
  name: string;
  source: string;
}

/** The `# file: <name>` boundary `chant audit` writes between joined `.tf` files. */
const FILE_MARKER = /^# file: (.+)$/;

/**
 * Split the joined form back into files. A string with no marker at all is one
 * anonymous file, so a caller that hands over a single `.tf` still parses.
 */
export function splitBundleContent(content: string, fallbackName = "main.tf"): TerraformFile[] {
  const files: TerraformFile[] = [];
  let current: TerraformFile | undefined;
  for (const line of content.split("\n")) {
    const marker = FILE_MARKER.exec(line);
    if (marker) {
      current = { name: marker[1].trim(), source: "" };
      files.push(current);
      continue;
    }
    if (!current) {
      current = { name: fallbackName, source: "" };
      files.push(current);
    }
    current.source += current.source === "" ? line : `\n${line}`;
  }
  return files.filter((f) => f.source.trim() !== "");
}

/** Every `.tf` directly under `dir`, in filename order. Non-recursive. */
export function listTerraformFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".tf"))
    .sort();
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Parse a set of files into entities keyed `<root>/<address>`. Two blocks that
 * genuinely share an address (two `locals` blocks, or the same address in two
 * files of one root) are numbered `~2`, `~3` rather than overwriting.
 */
export async function blocksToEntities(
  files: readonly TerraformFile[],
  root: string,
  hcl2json?: Hcl2Json,
): Promise<Map<string, Declarable>> {
  const parser = hcl2json ?? (await loadHcl2json());
  const entities = new Map<string, Declarable>();

  const add = (entityType: string, address: string, body: unknown, file: string): void => {
    const entity = terraformEntity(
      entityType,
      address,
      (typeof body === "object" && body !== null ? body : {}) as BlockBody,
      file,
      root,
    );
    let key = `${root}/${address}`;
    for (let n = 2; entities.has(key); n++) key = `${root}/${address}~${n}`;
    entities.set(key, entity);
  };

  /** `terraform` and `locals` carry no labels: the tree holds a bare body array. */
  const unlabelled = (
    tree: Record<string, unknown>,
    section: string,
    entityType: string,
    file: string,
  ): void => {
    for (const body of asArray(tree[section])) add(entityType, section, body, file);
  };

  /** `provider`, `module`, `variable`, `output`: one label, so `Record<name, body[]>`. */
  const oneLabel = (
    tree: Record<string, unknown>,
    section: string,
    entityType: string,
    address: (name: string) => string,
    file: string,
  ): void => {
    for (const [name, bodies] of Object.entries(asRecord(tree[section]))) {
      for (const body of asArray(bodies)) add(entityType, address(name), body, file);
    }
  };

  /** `resource`, `data`: two labels, so `Record<type, Record<name, body[]>>`. */
  const twoLabels = (
    tree: Record<string, unknown>,
    section: string,
    entityType: string,
    address: (type: string, name: string) => string,
    file: string,
  ): void => {
    for (const [type, named] of Object.entries(asRecord(tree[section]))) {
      for (const [name, bodies] of Object.entries(asRecord(named))) {
        for (const body of asArray(bodies)) add(entityType, address(type, name), body, file);
      }
    }
  };

  for (const file of files) {
    const tree = (await parser.parse(file.name, file.source)) as Record<string, unknown>;
    unlabelled(tree, "terraform", TERRAFORM_TYPE, file.name);
    unlabelled(tree, "locals", LOCALS_TYPE, file.name);
    oneLabel(tree, "provider", PROVIDER_TYPE, (n) => `provider.${n}`, file.name);
    oneLabel(tree, "module", MODULE_TYPE, (n) => `module.${n}`, file.name);
    oneLabel(tree, "variable", VARIABLE_TYPE, (n) => `var.${n}`, file.name);
    oneLabel(tree, "output", OUTPUT_TYPE, (n) => `output.${n}`, file.name);
    twoLabels(tree, "resource", RESOURCE_TYPE, (t, n) => `${t}.${n}`, file.name);
    twoLabels(tree, "data", DATA_TYPE, (t, n) => `data.${t}.${n}`, file.name);
  }

  return entities;
}

/**
 * Parse a root module directory. Reads every `.tf` directly under `dir`.
 * Throws whatever the parser throws for malformed HCL; `buildRoots()` is where
 * that becomes a warning.
 */
export async function parseTerraformRootDir(
  dir: string,
  root: string,
  hcl2json?: Hcl2Json,
): Promise<Map<string, Declarable>> {
  const files = listTerraformFiles(dir).map((name) => ({
    name,
    source: readFileSync(join(dir, name), "utf-8"),
  }));
  return blocksToEntities(files, root, hcl2json);
}

/**
 * Parse the joined-file string form `chant audit` produces for a discovered
 * root module (`AuditInput.content`). Unwired for now: #2085's
 * `auditEntities()` is what calls it.
 */
export async function parseTerraformRootContent(
  content: string,
  root: string,
  hcl2json?: Hcl2Json,
): Promise<Map<string, Declarable>> {
  return blocksToEntities(splitBundleContent(content), root, hcl2json);
}
