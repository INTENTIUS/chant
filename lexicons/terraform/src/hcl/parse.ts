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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadHcl2json, type Hcl2Json } from "@intentius/chant/terraform/parse";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";

/** A parsed HCL block body, as `@cdktf/hcl2json` encodes it. */
export type BlockBody = Record<string, unknown>;

/** Whether a root runs under choudoufu with a declared estate (#2103). */
export type TerraformRootMode = "live" | "state";

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
    /**
     * Whether this root is live: `terraform.binary` is `"choudoufu"` and an
     * estate is declared (a `live` block or an `estate.chdf.hcl` sidecar).
     * Set on every entity of the root, not just the `Terraform::Live` one, so
     * a post-synth check or `describeResources()` reads it without
     * re-parsing (#2103). Absent when the caller supplied no `binary` (the
     * `chant audit` content path, which has no project config to read).
     */
    readonly mode?: TerraformRootMode;
    /** The declared estate name. Present only when `mode` is `"live"`. */
    readonly estate?: string;
    /** `terraform.roots.<name>.workspace`, recorded so TF025 can flag a non-default one on a live root. */
    readonly workspace?: string;
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
/** A `live { estate = "..." }` block, or an `estate.chdf.hcl` sidecar's content (#2103). */
export const LIVE_TYPE = "Terraform::Live";

/** The sidecar filename choudoufu reads an estate declaration from when no in-block `live { }` is used. */
export const LIVE_SIDECAR_FILENAME = "estate.chdf.hcl";

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
  extra?: { mode?: TerraformRootMode; estate?: string; workspace?: string },
): TerraformEntity {
  return {
    [DECLARABLE_MARKER]: true,
    lexicon: "terraform",
    entityType,
    kind: "resource",
    props: {
      address,
      body,
      file,
      root,
      ...(extra?.mode !== undefined ? { mode: extra.mode } : {}),
      ...(extra?.estate !== undefined ? { estate: extra.estate } : {}),
      ...(extra?.workspace !== undefined ? { workspace: extra.workspace } : {}),
    },
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

/**
 * Read the `estate.chdf.hcl` sidecar beside `dir`'s `.tf` files, if present.
 * Sibling to {@link listTerraformFiles}: the sidecar is plain HCL (a bare
 * `estate = "..."` attribute, no wrapper block) and is never a `.tf` file, so
 * it falls outside that glob and needs its own read.
 */
export function readLiveSidecarFile(dir: string): TerraformFile | undefined {
  const path = join(dir, LIVE_SIDECAR_FILENAME);
  if (!existsSync(path)) return undefined;
  return { name: LIVE_SIDECAR_FILENAME, source: readFileSync(path, "utf-8") };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Every `live { ... }` block nested inside every `terraform { ... }` block of `tree`. */
function liveBlocksIn(tree: Record<string, unknown>): BlockBody[] {
  const out: BlockBody[] = [];
  for (const tfBody of asArray(tree["terraform"])) {
    const body = asRecord(tfBody);
    for (const liveBody of asArray(body["live"])) out.push(asRecord(liveBody));
  }
  return out;
}

/**
 * Options threading the config-level facts a root's mode depends on into the
 * parse, so `blocksToEntities` can stamp `mode`/`estate`/`workspace` onto
 * every entity without a second pass over the project config (#2103).
 */
export interface TerraformRootModeOptions {
  /** `terraform.binary`. A root is live only when this is `"choudoufu"` and an estate is declared. */
  binary?: string;
  /** `terraform.roots.<name>.workspace`, recorded verbatim regardless of mode. */
  workspace?: string;
}

/**
 * Parse a set of files into entities keyed `<root>/<address>`. Two blocks that
 * genuinely share an address (two `locals` blocks, or the same address in two
 * files of one root) are numbered `~2`, `~3` rather than overwriting.
 *
 * Recognises both ways an estate is declared: a `live { }` block nested in a
 * `terraform { }` block of any file here, and, when `sidecar` is given, the
 * `estate.chdf.hcl` sidecar's bare `estate = "..."` attribute. Either becomes
 * a {@link LIVE_TYPE} entity, and the root is live (`mode: "live"`) exactly
 * when `modeOptions.binary` is `"choudoufu"` and one of the two named an
 * estate; that verdict, and the estate name when live, is then stamped onto
 * every entity this call returns, sidecar and in-block declaration alike so
 * a post-synth check or `describeResources()` reads it without re-parsing.
 * When both forms are present the sidecar wins, matching choudoufu's own
 * "the sidecar is the leading one" (choudoufu refuses the combination
 * outright; this lexicon does not police that here, see TF024/TF025 for
 * what it does police on a live root).
 */
export async function blocksToEntities(
  files: readonly TerraformFile[],
  root: string,
  hcl2json?: Hcl2Json,
  modeOptions?: TerraformRootModeOptions,
  sidecar?: TerraformFile,
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
      modeOptions?.workspace !== undefined ? { workspace: modeOptions.workspace } : undefined,
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
    for (const liveBody of liveBlocksIn(tree)) add(LIVE_TYPE, "live", liveBody, file.name);
    unlabelled(tree, "locals", LOCALS_TYPE, file.name);
    oneLabel(tree, "provider", PROVIDER_TYPE, (n) => `provider.${n}`, file.name);
    oneLabel(tree, "module", MODULE_TYPE, (n) => `module.${n}`, file.name);
    oneLabel(tree, "variable", VARIABLE_TYPE, (n) => `var.${n}`, file.name);
    oneLabel(tree, "output", OUTPUT_TYPE, (n) => `output.${n}`, file.name);
    twoLabels(tree, "resource", RESOURCE_TYPE, (t, n) => `${t}.${n}`, file.name);
    twoLabels(tree, "data", DATA_TYPE, (t, n) => `data.${t}.${n}`, file.name);
  }

  if (sidecar) {
    const tree = (await parser.parse(sidecar.name, sidecar.source)) as Record<string, unknown>;
    if (typeof tree["estate"] === "string") add(LIVE_TYPE, "live", tree, sidecar.name);
  }

  // Which of the (at most two) Live entities names the estate, preferring the
  // sidecar over an in-block declaration when both are present.
  let estate: string | undefined;
  for (const entity of entities.values()) {
    if (entity.entityType !== LIVE_TYPE) continue;
    const props = (entity as TerraformEntity).props;
    const name = typeof props.body["estate"] === "string" ? (props.body["estate"] as string) : undefined;
    if (name === undefined) continue;
    if (estate === undefined || props.file === LIVE_SIDECAR_FILENAME) estate = name;
  }

  const mode: TerraformRootMode = modeOptions?.binary === "choudoufu" && estate !== undefined ? "live" : "state";
  for (const [key, entity] of entities) {
    const te = entity as TerraformEntity;
    const stamped: TerraformEntity = {
      ...te,
      props: { ...te.props, mode, ...(mode === "live" ? { estate } : {}) },
    };
    entities.set(key, stamped);
  }

  return entities;
}

/**
 * Parse a root module directory. Reads every `.tf` directly under `dir`, plus
 * the `estate.chdf.hcl` sidecar beside them when present. Throws whatever the
 * parser throws for malformed HCL; `buildRoots()` is where that becomes a
 * warning.
 */
export async function parseTerraformRootDir(
  dir: string,
  root: string,
  hcl2json?: Hcl2Json,
  modeOptions?: TerraformRootModeOptions,
): Promise<Map<string, Declarable>> {
  const files = listTerraformFiles(dir).map((name) => ({
    name,
    source: readFileSync(join(dir, name), "utf-8"),
  }));
  return blocksToEntities(files, root, hcl2json, modeOptions, readLiveSidecarFile(dir));
}

/**
 * Parse the joined-file string form `chant audit` produces for a discovered
 * root module (`AuditInput.content`). `auditEntities()` is what calls it; that
 * hook's single-argument contract carries no project config, so `modeOptions`
 * is left undefined there and every entity gets `mode: "state"`; the audit
 * path does not detect live mode (#2103). `modeOptions` exists here mainly for
 * tests exercising the mode-stamping behaviour directly against inline HCL,
 * the same way `parseTerraformRootDir`'s callers exercise it against files.
 */
export async function parseTerraformRootContent(
  content: string,
  root: string,
  hcl2json?: Hcl2Json,
  modeOptions?: TerraformRootModeOptions,
): Promise<Map<string, Declarable>> {
  return blocksToEntities(splitBundleContent(content), root, hcl2json, modeOptions);
}
