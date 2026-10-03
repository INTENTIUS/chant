/**
 * `chant workspace box listing set <member>` (#3308): change a box's listing,
 * `members[i].box.listing` in the declaration (#3146, ws-077), through chant.
 *
 * ws-074 makes the repo the database and lets a tool write only through
 * chant's write contract. The listing is configuration on the box block, so
 * before this a tool such as hud would have had to edit `chant.workspace.json`
 * itself. This write changes only the listing's own properties, in place, so
 * the file keeps its formatting, key order and, in a `.jsonc` file, its
 * comments. It can copy a cover image into the repository and point the
 * listing at it. It validates the declaration it would write, judges every
 * path it writes by the write scope at base (`judgePath`, the rule `check
 * --changes` applies to the commit later), refuses a bare `--by` name under
 * `identity.attribution: "identified"` (ws-080), prints one JSON document
 * (`box-listing-write.schema.json`) and never commits: the caller commits, as
 * after the records writes.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { listingView, treeBytes, type ListingView } from "./box-factory";
import { parseDeclaration, readDeclaration, readerVersion, WORKSPACE_ERROR_CODES, WorkspaceReadError, type Declaration, type Member } from "./declaration";
import { IDENTITY_CODES, IdentityError, refuseUnidentified } from "./identity";
import { removeProperty, setProperty, valueAt } from "./json-edit";
import { parseJsonText } from "./jsonc";
import type { ReasonCode } from "./reason-codes";
import { workingTree } from "./tree";
import { locateWorkspace } from "./which-chant";
import { judgePath, resolveWriter, scopeSource, unknownClassVerdict, WriteScopeError } from "./write-scope";

/** The version of the document this write prints. */
export const BOX_LISTING_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for what `box listing set` prints, shipped beside this file. */
export const BOX_LISTING_WRITE_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/box-listing-write/v1/box-listing-write.schema.json";

/** Why a listing write wrote nothing. Closed. */
export const BOX_LISTING_ERROR_CODES = [
  ...WORKSPACE_ERROR_CODES,
  "write-usage-invalid",
  "write-input-invalid",
  "listing-member-unknown",
  "listing-box-missing",
  "listing-cover-invalid",
  "write-scope-member",
  "write-scope-protected",
  "write-scope-class-unknown",
  "agent-unknown",
  ...IDENTITY_CODES,
] as const satisfies readonly ReasonCode[];
export type BoxListingErrorCode = (typeof BOX_LISTING_ERROR_CODES)[number];

/** The listing properties a write may set. Any `x-` key is passed through as well. */
export const LISTING_FIELDS = ["published", "title", "line", "cover"] as const;

/** The largest cover image the write copies, in bytes. */
export const COVER_MAX_BYTES = 5 * 1024 * 1024;

/** The picture formats a cover may be, by the extension its file takes. */
const COVER_TYPES = [
  { type: "image/png", ext: "png", exts: ["png"], magic: (b: Uint8Array) => b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x) },
  { type: "image/jpeg", ext: "jpg", exts: ["jpg", "jpeg"], magic: (b: Uint8Array) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: "image/webp",
    ext: "webp",
    exts: ["webp"],
    magic: (b: Uint8Array) => b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP",
  },
] as const;
type CoverType = (typeof COVER_TYPES)[number];

/** What `box listing set` prints. */
export type BoxListingWriteDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      member: string;
      /** The declaration file, from the repository root, and the sha256 of its bytes after the write (or as it would be, with dryRun). */
      declaration: { path: string; sha256: string };
      /** Every file the write changed, from the repository root: the declaration and the cover it copied. Empty when nothing changed. */
      paths: string[];
      changed: boolean;
      dryRun: boolean;
      /** The listing before the write, as status --json prints it, or null when the box declared none. */
      previous: ListingView | null;
      /** The listing after the write, as status --json prints it. */
      listing: ListingView;
      /** The cover copied with --cover, or null. */
      cover: { path: string; sha256: string; bytes: number; type: string; replaced: string | null } | null;
    }
  | { $schema: string; contract: number; chant: string; member: string | null; error: { code: BoxListingErrorCode; message: string } };

export interface BoxListingWriteRequest {
  cwd: string;
  member: string;
  /** The listing fields as JSON text (`--from`), or undefined. */
  fields?: string;
  /** An image to copy in as the cover (`--cover`), from `cwd`. */
  cover?: string;
  /** Where to copy it, from the workspace root (`--cover-path`). */
  coverPath?: string;
  /** Who is writing (`--by`). */
  by?: string;
  /** The agent session (`CHANT_AGENT`). */
  agent?: string;
  dryRun?: boolean;
}

class ListingWriteError extends Error {
  constructor(
    readonly code: BoxListingErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const toPosix = (p: string) => (sep === "/" ? p : p.split(sep).join("/"));
const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A path from the workspace root that stays inside it, with / separators, or a reason it isn't one. */
function workspacePath(raw: string, what: string): string {
  const p = toPosix(raw).replace(/^\.\//, "");
  const norm = posix.normalize(p);
  if (p === "" || isAbsolute(raw) || norm.startsWith("../") || norm === ".." || norm !== p || p.endsWith("/")) {
    throw new ListingWriteError("listing-cover-invalid", `${what} ${JSON.stringify(raw)} is not a file path from the workspace root: give it relative, normalised and inside the workspace`);
  }
  if (p.split("/")[0] === ".git") throw new ListingWriteError("listing-cover-invalid", `${what} ${JSON.stringify(raw)} is inside .git`);
  return p;
}

function sniff(bytes: Uint8Array, what: string): CoverType {
  const t = COVER_TYPES.find((c) => c.magic(bytes));
  if (!t) throw new ListingWriteError("listing-cover-invalid", `${what} is not a PNG, JPEG or WebP picture`);
  return t;
}

/** The listing fields given with --from: a JSON object of published, title, line, cover and x- keys; null for a key takes it out. */
function readFields(text: string | undefined): Record<string, unknown> {
  if (text === undefined || text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new ListingWriteError("write-input-invalid", `the listing fields are not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(value)) throw new ListingWriteError("write-input-invalid", "the listing fields are a JSON object, such as {\"title\": \"...\", \"line\": \"...\"}");
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith("x-")) continue;
    if (!(LISTING_FIELDS as readonly string[]).includes(k)) throw new ListingWriteError("write-input-invalid", `${k} is not a listing field; a listing takes ${LISTING_FIELDS.join(", ")} and x- keys`);
    if (v === null) continue;
    if (k === "published" && typeof v !== "boolean") throw new ListingWriteError("write-input-invalid", "published is true or false, or null to take it out");
    if (k !== "published" && typeof v !== "string") throw new ListingWriteError("write-input-invalid", `${k} is a string, or null to take it out`);
  }
  return value;
}

/** Write `bytes` to `file` through a sibling temporary file, so a reader never sees half of it. */
function writeAtomically(file: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.chant-${process.pid}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
}

/** Run the write and build the document it prints. Never throws for a refusal. */
export function boxListingSet(req: BoxListingWriteRequest): BoxListingWriteDocument {
  const head = { $schema: BOX_LISTING_WRITE_SCHEMA_ID, contract: BOX_LISTING_CONTRACT_VERSION, chant: readerVersion() };
  try {
    return write(req, head);
  } catch (err) {
    const fail = (code: BoxListingErrorCode, message: string): BoxListingWriteDocument => ({ ...head, member: req.member || null, error: { code, message } });
    if (err instanceof ListingWriteError) return fail(err.code, err.message);
    // A path write is never judged write-scope-kind, which is for record kinds.
    if (err instanceof WriteScopeError) return fail(err.code as BoxListingErrorCode, err.message);
    if (err instanceof IdentityError) return fail(err.code, err.message);
    if (err instanceof WorkspaceReadError) return fail(err.code as BoxListingErrorCode, err.describe());
    throw err;
  }
}

function write(req: BoxListingWriteRequest, head: { $schema: string; contract: number; chant: string }): BoxListingWriteDocument {
  if (!req.member) throw new ListingWriteError("write-usage-invalid", "box listing set needs the member whose box it lists: box listing set <member>");
  if (req.coverPath !== undefined && req.cover === undefined) throw new ListingWriteError("write-usage-invalid", "--cover-path says where --cover's image goes, and no --cover was given");
  const fields = readFields(req.fields);
  if (req.cover !== undefined && "cover" in fields) throw new ListingWriteError("write-usage-invalid", "give the cover once: --cover copies an image in, and a cover field names a file already in the workspace");
  if (req.cover === undefined && req.fields === undefined) throw new ListingWriteError("write-usage-invalid", "box listing set needs --from <file|-> with the listing fields, --cover <image>, or both");

  const located = locateWorkspace(req.cwd);
  const declaration = readDeclaration(located.tree);
  const member = declaration.members.find((m) => m.name === req.member);
  if (!member) {
    throw new ListingWriteError("listing-member-unknown", `no member is named ${req.member}; the declaration's members are ${declaration.members.map((m) => m.name).join(", ") || "none"}`);
  }
  if (!member.box) throw new ListingWriteError("listing-box-missing", `member ${member.name} declares no box block, so it has no listing; a listing is what a box shows of itself (#3146)`);

  const repoBase = located.top ?? located.rootOnDisk;
  const fromRepo = (pathInWorkspace: string) => toPosix(relative(repoBase, join(located.rootOnDisk, ...pathInWorkspace.split("/"))));
  const declFile = join(located.rootOnDisk, declaration.file);
  const before = readFileSync(declFile, "utf-8");
  const jsonc = declaration.file.endsWith(".jsonc");

  // The cover: an image copied in, or a file already in the workspace.
  let copy: { path: string; bytes: Uint8Array; type: CoverType; replaced: string | null } | null = null;
  if (req.cover !== undefined) {
    const src = resolve(req.cwd, req.cover);
    let bytes: Uint8Array;
    try {
      if (statSync(src).size > COVER_MAX_BYTES) throw new ListingWriteError("listing-cover-invalid", `--cover ${req.cover} is larger than ${COVER_MAX_BYTES} bytes; a cover is a picture for a listing, so make it smaller`);
      bytes = readFileSync(src);
    } catch (err) {
      if (err instanceof ListingWriteError) throw err;
      throw new ListingWriteError("listing-cover-invalid", `--cover ${req.cover} can't be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    const type = sniff(bytes, `--cover ${req.cover}`);
    const current = member.box.listing?.cover ?? null;
    const dir = member.dir === "." ? "" : `${member.dir}/`;
    const path =
      req.coverPath !== undefined
        ? workspacePath(req.coverPath, "--cover-path")
        : current !== null && (type.exts as readonly string[]).includes(posix.extname(current).slice(1).toLowerCase())
          ? current
          : `${dir}listing/cover.${type.ext}`;
    const ext = posix.extname(path).slice(1).toLowerCase();
    if (!(type.exts as readonly string[]).includes(ext)) throw new ListingWriteError("listing-cover-invalid", `--cover ${req.cover} is ${type.type}, and ${path} has the extension .${ext}; name it .${type.ext}`);
    if (path === declaration.file) throw new ListingWriteError("listing-cover-invalid", `--cover-path names the declaration itself`);
    copy = { path, bytes, type, replaced: current !== null && current !== path ? current : null };
    fields.cover = path;
  } else if (typeof fields.cover === "string") {
    const path = workspacePath(fields.cover, "cover");
    const bytes = treeBytes(workingTree(located.rootOnDisk))(path);
    if (bytes === null) throw new ListingWriteError("listing-cover-invalid", `cover ${path} is not a file in the workspace; copy an image in with --cover <image> instead`);
    sniff(bytes, `cover ${path}`);
    fields.cover = path;
  }

  // The declaration, with only the listing's own properties changed.
  const boxPointer = member.box.pointer;
  const listingPointer = `${boxPointer}/listing`;
  const parsedBefore = parseJsonText(before, { jsonc });
  if (!parsedBefore.ok) throw new WorkspaceReadError("declaration-unparseable", parsedBefore.message);
  const rawListing = valueAt(parsedBefore.value, listingPointer);
  let after = before;
  const expected = structuredClone(parsedBefore.value) as Record<string, unknown>;
  const expectedBox = valueAt(expected, boxPointer) as Record<string, unknown>;
  if (rawListing === undefined) {
    const value = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
    after = setProperty(after, jsonc, boxPointer, "listing", value);
    expectedBox.listing = value;
  } else {
    const expectedListing = expectedBox.listing as Record<string, unknown>;
    for (const [k, v] of Object.entries(fields)) {
      if (v === null) {
        after = removeProperty(after, jsonc, listingPointer, k);
        delete expectedListing[k];
      } else {
        after = setProperty(after, jsonc, listingPointer, k, v);
        expectedListing[k] = v;
      }
    }
  }
  const parsedAfter = parseJsonText(after, { jsonc });
  if (!parsedAfter.ok || JSON.stringify(parsedAfter.value) !== JSON.stringify(expected)) {
    // An edit that does not read back as the value meant is never written.
    throw new Error(`box listing set: editing ${declaration.file} in place did not give the declaration intended; nothing was written`);
  }
  let next: Declaration;
  try {
    next = parseDeclaration(after, declaration.file);
  } catch (err) {
    if (err instanceof WorkspaceReadError) throw new ListingWriteError("write-input-invalid", `the listing would make the declaration invalid: ${err.describe()}`);
    throw err;
  }
  const nextMember = next.members.find((m) => m.name === member.name) as Member;

  // The write scope at base, for each file written, and who --by names.
  const source = scopeSource(req.cwd);
  if (req.by !== undefined) refuseUnidentified(source, [req.by], "--by", { agent: req.agent });
  if (source.declaration !== null || (req.agent !== undefined && req.agent !== "")) {
    const writer = resolveWriter(source.declaration, source.policy, { agent: req.agent || null, principal: req.by ?? null }, source.classes);
    const unknown = unknownClassVerdict(source.declaration, writer, source.classes);
    if (!unknown.ok) throw new WriteScopeError(unknown.code, unknown.message);
    const judge = (path: string, change?: { before(): string | null; after(): string | null }) => {
      const verdict = judgePath(source.declaration, writer, path, change);
      if (!verdict.ok) throw new ListingWriteError(verdict.code as BoxListingErrorCode, verdict.message);
    };
    if (after !== before) judge(declaration.file, { before: () => before, after: () => after });
    if (copy) judge(copy.path);
  }

  // Write: the cover first, so the declaration never names a cover that isn't there.
  const paths: string[] = [];
  const coverFile = copy ? join(located.rootOnDisk, ...copy.path.split("/")) : null;
  const coverChanged = copy !== null && !(existsSync(coverFile!) && sha256(readFileSync(coverFile!)) === sha256(copy.bytes));
  if (copy && coverChanged) {
    if (!req.dryRun) writeAtomically(coverFile!, copy.bytes);
    paths.push(fromRepo(copy.path));
  }
  if (after !== before) {
    if (!req.dryRun) writeAtomically(declFile, after);
    paths.push(fromRepo(declaration.file));
  }

  const read = treeBytes(workingTree(located.rootOnDisk));
  const readAfter = (p: string) => (copy && p === copy.path ? copy.bytes : read(p));
  return {
    ...head,
    member: member.name,
    declaration: { path: fromRepo(declaration.file), sha256: sha256(after) },
    paths,
    changed: paths.length > 0,
    dryRun: req.dryRun === true,
    previous: listingView(member.box.listing, read),
    listing: listingView(nextMember.box!.listing, readAfter)!,
    cover: copy ? { path: copy.path, sha256: sha256(copy.bytes), bytes: copy.bytes.length, type: copy.type.type, replaced: copy.replaced } : null,
  };
}
