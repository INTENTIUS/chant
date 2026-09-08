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
import type { EntityReference } from "@intentius/chant/graph-ir";
import type { SuppressionDirective } from "@intentius/chant/lint/suppressions";
import type { TerraformDeleteMode } from "../config";
import { scanSuppressions, directivesFor, type FileScan } from "./suppressions";

/** A parsed HCL block body, as `@cdktf/hcl2json` encodes it. */
export type BlockBody = Record<string, unknown>;

/**
 * The meta-argument that expands a block into instances, when it carries one
 * (chant #2265). Recorded because chant's entity is the BLOCK, one node
 * whatever `count` evaluates to, so an edge out of an expanded block is
 * block-to-block and says nothing about how many instances reference how many
 * others. That is the honest shape for a read of the declaration alone, since
 * the instance count is a plan-time answer and often a state-time one, but it
 * is a shape a reader should be told rather than left to infer from a node
 * count that never grows.
 */
export type TerraformExpansion = "count" | "for_each";

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
     * The chain of `module.<name>` calls that reached this block, outermost
     * first (chant #2112). Empty or absent on a block declared in the root
     * module itself; `["module.cdn"]` on a block of the module `./modules/cdn`
     * called as `cdn` from the root; `["module.cdn", "module.bucket"]` one
     * level deeper. The same chain is in the entity key, which is
     * `<root>/module.cdn/<address>` for the first case, so a reader can tell
     * root scope from child scope from either.
     *
     * The names are the CALL names (`module.<label>`), not the directory the
     * source points at, matching `terraform show -json`'s `child_modules[]`
     * addresses, choudoufu's marker grammar, and tflint's `Callers:` chain.
     */
    readonly callers?: readonly string[];
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
    /**
     * `terraform.roots.<name>.delete` (#2106), recorded so TF026 can check a
     * live root declaring `"never"` against its `policy` block's
     * `undeclared_tagged` setting. Present regardless of mode, same as
     * `workspace`; only a live root's TF026 reads it.
     */
    readonly delete?: TerraformDeleteMode;
    /**
     * 1-based line the block's header starts on, from a line scan over the
     * raw source (chant #2111): hcl2json exposes no ranges to read this from
     * instead (see `../hcl/suppressions.ts`). Undefined when the scan's block
     * regex didn't recognize the header (unusual formatting); a suppression
     * comment simply can't anchor to that block then.
     */
    readonly line?: number;
    /**
     * The raw text of the file this block came from, verbatim.
     *
     * Every other field here is post-`hcl2json`, and that parse is lossy in
     * one way that matters: it renders a bare reference (`value = var.x`) and
     * a quoted interpolation (`value = "${var.x}"`) as the same string,
     * `"${var.x}"`. The second is the deprecated pre-0.12 form TF016 reports
     * and the first is idiomatic, so a check written against `body` alone
     * would flag every reference in the root. The source text is where the
     * quotes still exist. Empty when a caller built the entity by hand.
     */
    readonly source: string;
    /**
     * `count` or `for_each` when the block carries one (chant #2265). See
     * {@link TerraformExpansion} for why one node still stands for the whole
     * expansion.
     */
    readonly expansion?: TerraformExpansion;
  };
  /**
   * The deployable unit this entity belongs to: the root name, which is what
   * one `terraform apply` runs against (chant #2266).
   *
   * Duplicates `props.root`, deliberately. `props` is what this lexicon's own
   * checks and serializer read; `stack` is the lexicon-neutral field core's
   * `buildGraphIr` reads to key `groups.byStack`, so a five-root project draws
   * as five boundary boxes instead of one bucket named `terraform`. Core has
   * no business reaching into a lexicon's `props` to find out, and this
   * lexicon has no business knowing how the grouping is built, so the fact is
   * said once in each vocabulary. A child module's blocks carry the calling
   * ROOT's name, not the module's: the module is not separately applied.
   */
  readonly stack: string;
  /**
   * Every reference in this block, resolved to the entity keys it points at
   * (chant #2265), in core's lexicon-neutral {@link EntityReference} shape.
   *
   * Absent until `./edges.ts` resolves it, which needs the whole root's entity
   * set and so cannot happen inside the per-file parse below. An entity that
   * never went through that pass carries none, which reads as "no references
   * were resolved", never as "this block references nothing".
   */
  readonly references?: readonly EntityReference[];
  /**
   * `# chant-ignore`/`chant-ignore-file`/`chant-ignore-block` directives that
   * apply to this entity (chant #2111): the ones anchored to its own block,
   * plus any file-level one. Read generically by
   * `@intentius/chant/lint/suppressions`'s `entitySuppressions()`; see that
   * module's doc comment for why this is a plain duck-typed field rather than
   * a `PostSynthContext` addition.
   */
  readonly suppressions?: readonly SuppressionDirective[];
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

/** The expansion meta-argument a block body carries, if any. `count` wins if both are present (Terraform rejects that combination anyway). */
function expansionOf(body: BlockBody): TerraformExpansion | undefined {
  if ("count" in body) return "count";
  if ("for_each" in body) return "for_each";
  return undefined;
}

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
  extra?: { mode?: TerraformRootMode; estate?: string; workspace?: string; delete?: TerraformDeleteMode; callers?: readonly string[] },
  source: string = "",
  line?: number,
  suppressions?: readonly SuppressionDirective[],
): TerraformEntity {
  const expansion = expansionOf(body);
  return {
    [DECLARABLE_MARKER]: true,
    lexicon: "terraform",
    entityType,
    kind: "resource",
    stack: root,
    props: {
      address,
      body,
      file,
      root,
      source,
      line,
      ...(expansion ? { expansion } : {}),
      ...(extra?.mode !== undefined ? { mode: extra.mode } : {}),
      ...(extra?.estate !== undefined ? { estate: extra.estate } : {}),
      ...(extra?.workspace !== undefined ? { workspace: extra.workspace } : {}),
      ...(extra?.delete !== undefined ? { delete: extra.delete } : {}),
      ...(extra?.callers !== undefined && extra.callers.length > 0 ? { callers: extra.callers } : {}),
    },
    suppressions,
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
  /** `terraform.roots.<name>.delete`, recorded verbatim regardless of mode (#2106). */
  delete?: TerraformDeleteMode;
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
 *
 * `callers` is the module-call chain these files were reached through
 * (chant #2112), empty for a root module. When it is non-empty the keys
 * become `<root>/module.<name>/<address>` (one segment per caller) and every
 * entity carries the chain on `props.callers`. `./descend.ts` is what fills
 * it in; nothing else should pass it.
 */
export async function blocksToEntities(
  files: readonly TerraformFile[],
  root: string,
  hcl2json?: Hcl2Json,
  modeOptions?: TerraformRootModeOptions,
  sidecar?: TerraformFile,
  callers: readonly string[] = [],
): Promise<Map<string, Declarable>> {
  const parser = hcl2json ?? (await loadHcl2json());
  const entities = new Map<string, Declarable>();
  const prefix = callers.length > 0 ? `${root}/${callers.join("/")}` : root;

  const add = (entityType: string, address: string, body: unknown, file: TerraformFile, scan: FileScan): void => {
    const { line, suppressions } = directivesFor(scan, address);
    const entity = terraformEntity(
      entityType,
      address,
      (typeof body === "object" && body !== null ? body : {}) as BlockBody,
      file.name,
      root,
      {
        ...(modeOptions?.workspace !== undefined ? { workspace: modeOptions.workspace } : {}),
        ...(modeOptions?.delete !== undefined ? { delete: modeOptions.delete } : {}),
        ...(callers.length > 0 ? { callers } : {}),
      },
      file.source,
      line,
      suppressions,
    );
    let key = `${prefix}/${address}`;
    for (let n = 2; entities.has(key); n++) key = `${prefix}/${address}~${n}`;
    entities.set(key, entity);
  };

  /** `terraform` and `locals` carry no labels: the tree holds a bare body array. */
  const unlabelled = (
    tree: Record<string, unknown>,
    section: string,
    entityType: string,
    file: TerraformFile,
    scan: FileScan,
  ): void => {
    for (const body of asArray(tree[section])) add(entityType, section, body, file, scan);
  };

  /** `provider`, `module`, `variable`, `output`: one label, so `Record<name, body[]>`. */
  const oneLabel = (
    tree: Record<string, unknown>,
    section: string,
    entityType: string,
    address: (name: string) => string,
    file: TerraformFile,
    scan: FileScan,
  ): void => {
    for (const [name, bodies] of Object.entries(asRecord(tree[section]))) {
      for (const body of asArray(bodies)) add(entityType, address(name), body, file, scan);
    }
  };

  /** `resource`, `data`: two labels, so `Record<type, Record<name, body[]>>`. */
  const twoLabels = (
    tree: Record<string, unknown>,
    section: string,
    entityType: string,
    address: (type: string, name: string) => string,
    file: TerraformFile,
    scan: FileScan,
  ): void => {
    for (const [type, named] of Object.entries(asRecord(tree[section]))) {
      for (const [name, bodies] of Object.entries(asRecord(named))) {
        for (const body of asArray(bodies)) add(entityType, address(type, name), body, file, scan);
      }
    }
  };

  for (const file of files) {
    const tree = (await parser.parse(file.name, file.source)) as Record<string, unknown>;
    const scan = scanSuppressions(file.name, file.source);
    unlabelled(tree, "terraform", TERRAFORM_TYPE, file, scan);
    for (const liveBody of liveBlocksIn(tree)) add(LIVE_TYPE, "live", liveBody, file, scan);
    unlabelled(tree, "locals", LOCALS_TYPE, file, scan);
    oneLabel(tree, "provider", PROVIDER_TYPE, (n) => `provider.${n}`, file, scan);
    oneLabel(tree, "module", MODULE_TYPE, (n) => `module.${n}`, file, scan);
    oneLabel(tree, "variable", VARIABLE_TYPE, (n) => `var.${n}`, file, scan);
    oneLabel(tree, "output", OUTPUT_TYPE, (n) => `output.${n}`, file, scan);
    twoLabels(tree, "resource", RESOURCE_TYPE, (t, n) => `${t}.${n}`, file, scan);
    twoLabels(tree, "data", DATA_TYPE, (t, n) => `data.${t}.${n}`, file, scan);
  }

  if (sidecar) {
    const tree = (await parser.parse(sidecar.name, sidecar.source)) as Record<string, unknown>;
    if (typeof tree["estate"] === "string") add(LIVE_TYPE, "live", tree, sidecar, scanSuppressions(sidecar.name, sidecar.source));
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
  callers: readonly string[] = [],
): Promise<Map<string, Declarable>> {
  const files = listTerraformFiles(dir).map((name) => ({
    name,
    source: readFileSync(join(dir, name), "utf-8"),
  }));
  // A child module gets no sidecar read: `estate.chdf.hcl` declares the
  // estate a ROOT runs against, and choudoufu reads it from the root's own
  // directory only. See `./descend.ts`.
  const sidecar = callers.length === 0 ? readLiveSidecarFile(dir) : undefined;
  return blocksToEntities(files, root, hcl2json, modeOptions, sidecar, callers);
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

/** The root name an audit of the audited directory itself parses under. */
export const AUDIT_ROOT_NAME = "audit-root";

/**
 * The root name one `chant audit` input parses under (#2217).
 *
 * A build names its roots from `terraform.roots`; an audit has no such
 * config, so the name comes from the input's own path, which is the one thing
 * that tells two discovered roots apart. `envs/prod` becomes `envs.prod`,
 * because an entity key is `<root>/<address>` with the module chain between
 * them and a `/` inside the root name would read as a module scope. The
 * audited directory itself keeps the name {@link AUDIT_ROOT_NAME}, so a
 * single-root audit reads the way it did before an input path was available.
 */
export function auditRootName(path?: string): string {
  const trimmed = (path ?? "").replace(/^\.\//, "").replace(/\/+$/, "");
  if (trimmed === "" || trimmed === ".") return AUDIT_ROOT_NAME;
  return trimmed.replace(/\//g, ".");
}

/**
 * The module scope an entity key names: the part before the address.
 *
 * `"app/aws_s3_bucket.assets"` is scope `"app"` (the root module);
 * `"app/module.cdn/aws_s3_bucket.assets"` is scope `"app/module.cdn"`. Keys
 * are built here (see {@link blocksToEntities}), so the split lives here too:
 * the reference index (`./references.ts`) and the module-scoped checks read
 * scopes through it rather than re-deriving the key shape.
 */
export function scopeOfKey(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? "" : key.slice(0, slash);
}

/** The `module.<name>` chain in an entity key, outermost first. Empty for a root-module block. */
export function callersOfKey(key: string): string[] {
  const parts = key.split("/");
  return parts.length <= 2 ? [] : parts.slice(1, -1);
}
