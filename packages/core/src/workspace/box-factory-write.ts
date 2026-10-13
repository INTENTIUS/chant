/**
 * `chant workspace box factory set <member>` (#3600): change a box's
 * factory, `members[i].box.factory` in the declaration (#3146, ws-077),
 * through chant.
 *
 * A box planted from a shared template can't carry where it publishes:
 * `factory.publish.repo` must be a real owner/name, so the template leaves
 * it out and whoever plants the box, which knows the box's repo, sets it
 * here. The write is the factory's sibling of `box listing set` (#3308): it
 * changes only the factory's own top-level properties, in place, so the file
 * keeps its formatting, key order and comments; it validates the declaration
 * it would write, judges the declaration by the write scope at base (so a
 * protected declaration takes it when its `except` names
 * `/members/*\/box/factory/publish`), refuses a bare `--by` name under
 * `identity.attribution: "identified"`, holds the working tree's write lock,
 * prints one JSON document (`box-factory-write.schema.json`) and never
 * commits.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { factoryView, type FactoryView } from "./box-factory";
import { parseDeclaration, readDeclaration, readerVersion, WORKSPACE_ERROR_CODES, WorkspaceReadError, type Declaration } from "./declaration";
import { IDENTITY_CODES, IdentityError, refuseUnidentified } from "./identity";
import { removeProperty, setProperty, valueAt } from "./json-edit";
import { parseJsonText } from "./jsonc";
import type { ReasonCode } from "./reason-codes";
import { locateWorkspace } from "./which-chant";
import { judgePath, resolveWriter, scopeSource, unknownClassVerdict, WriteScopeError } from "./write-scope";
import { withWriteLockSync, WriteLockError, WRITE_LOCK_CODES } from "./write-lock";

/** The version of the document this write prints. */
export const BOX_FACTORY_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for what `box factory set` prints, shipped beside this file. */
export const BOX_FACTORY_WRITE_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/box-factory-write/v1/box-factory-write.schema.json";

/** Why a factory write wrote nothing. Closed. */
export const BOX_FACTORY_ERROR_CODES = [
  ...WORKSPACE_ERROR_CODES,
  "write-usage-invalid",
  "write-input-invalid",
  "factory-member-unknown",
  "factory-box-missing",
  "write-scope-member",
  "write-scope-protected",
  "write-scope-class-unknown",
  "agent-unknown",
  ...IDENTITY_CODES,
  ...WRITE_LOCK_CODES,
] as const satisfies readonly ReasonCode[];
export type BoxFactoryErrorCode = (typeof BOX_FACTORY_ERROR_CODES)[number];

/** The factory properties a write may set. Any `x-` key is passed through as well. */
export const FACTORY_FIELDS = ["builds", "check", "checks", "builders", "tiers", "publish"] as const;

type Head = { $schema: string; contract: number; chant: string };

/** What `box factory set` prints. */
export type BoxFactoryWriteDocument =
  | (Head & {
      member: string;
      /** The declaration file, from the repository root, and the sha256 of its bytes after the write (or as it would be, with dryRun). */
      declaration: { path: string; sha256: string };
      /** The declaration, from the repository root, when the write changed it; else empty. */
      paths: string[];
      changed: boolean;
      dryRun: boolean;
      /** The factory before the write, as status --json prints it, or null when the box declared none. */
      previous: FactoryView | null;
      /** The factory after the write, as status --json prints it, or null when the write took every field out. */
      factory: FactoryView | null;
    })
  | (Head & { member: string | null; error: { code: BoxFactoryErrorCode; message: string } });

export interface BoxFactoryWriteRequest {
  cwd: string;
  member: string;
  /** The factory fields as JSON text (`--from`). */
  fields?: string;
  /** Who is writing (`--by`). */
  by?: string;
  /** The agent session (`CHANT_AGENT`). */
  agent?: string;
  dryRun?: boolean;
}

class FactoryWriteError extends Error {
  constructor(
    readonly code: BoxFactoryErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const toPosix = (p: string) => (sep === "/" ? p : p.split(sep).join("/"));
const sha256 = (b: string) => createHash("sha256").update(b).digest("hex");
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The factory fields given with --from: a JSON object of the factory's fields and x- keys; null for a key takes it out. */
function readFields(text: string | undefined): Record<string, unknown> {
  if (text === undefined || text.trim() === "") throw new FactoryWriteError("write-usage-invalid", "box factory set needs the factory fields: --from <file|->, such as {\"publish\": {\"repo\": \"owner/name\"}}");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new FactoryWriteError("write-input-invalid", `the factory fields are not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(value)) throw new FactoryWriteError("write-input-invalid", "the factory fields are a JSON object, such as {\"publish\": {\"repo\": \"owner/name\"}}");
  for (const k of Object.keys(value)) {
    if (k.startsWith("x-") || (FACTORY_FIELDS as readonly string[]).includes(k)) continue;
    throw new FactoryWriteError("write-input-invalid", `${k} is not a factory field; a factory takes ${FACTORY_FIELDS.join(", ")} and x- keys`);
  }
  return value;
}

/** Write `text` to `file` through a sibling temporary file, so a reader never sees half of it. */
function writeAtomically(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.chant-${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Run the write and build the document it prints. Never throws for a refusal. */
export function boxFactorySet(req: BoxFactoryWriteRequest): BoxFactoryWriteDocument {
  const head: Head = { $schema: BOX_FACTORY_WRITE_SCHEMA_ID, contract: BOX_FACTORY_CONTRACT_VERSION, chant: readerVersion() };
  try {
    return withWriteLockSync(req.cwd, { verb: "box factory set", by: req.by ?? null, agent: req.agent || null }, req.dryRun, () => write(req, head));
  } catch (err) {
    const fail = (code: BoxFactoryErrorCode, message: string): BoxFactoryWriteDocument => ({ ...head, member: req.member || null, error: { code, message } });
    if (err instanceof FactoryWriteError) return fail(err.code, err.message);
    if (err instanceof WriteScopeError) return fail(err.code as BoxFactoryErrorCode, err.message);
    if (err instanceof IdentityError) return fail(err.code, err.message);
    if (err instanceof WriteLockError) return fail(err.code, err.message);
    if (err instanceof WorkspaceReadError) return fail(err.code as BoxFactoryErrorCode, err.describe());
    throw err;
  }
}

function write(req: BoxFactoryWriteRequest, head: Head): BoxFactoryWriteDocument {
  if (!req.member) throw new FactoryWriteError("write-usage-invalid", "box factory set needs the member whose box builds: box factory set <member>");
  const fields = readFields(req.fields);

  const located = locateWorkspace(req.cwd);
  const declaration = readDeclaration(located.tree);
  const member = declaration.members.find((m) => m.name === req.member);
  if (!member) {
    throw new FactoryWriteError("factory-member-unknown", `no member is named ${req.member}; the declaration's members are ${declaration.members.map((m) => m.name).join(", ") || "none"}`);
  }
  if (!member.box) throw new FactoryWriteError("factory-box-missing", `member ${member.name} declares no box block, so it has no factory; a factory is what a box builds (#3146)`);

  const repoBase = located.top ?? located.rootOnDisk;
  const declPath = toPosix(relative(repoBase, join(located.rootOnDisk, declaration.file)));
  const declFile = join(located.rootOnDisk, declaration.file);
  const before = readFileSync(declFile, "utf-8");
  const jsonc = declaration.file.endsWith(".jsonc");

  // The declaration, with only the factory's own properties changed.
  const boxPointer = member.box.pointer;
  const factoryPointer = `${boxPointer}/factory`;
  const parsed = parseJsonText(before, { jsonc });
  if (!parsed.ok) throw new WorkspaceReadError("declaration-unparseable", parsed.message);
  const raw = valueAt(parsed.value, factoryPointer);
  let after = before;
  const expected = structuredClone(parsed.value) as Record<string, unknown>;
  const expectedBox = valueAt(expected, boxPointer) as Record<string, unknown>;
  if (raw === undefined) {
    const value = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null));
    if (Object.keys(value).length > 0) {
      after = setProperty(after, jsonc, boxPointer, "factory", value);
      expectedBox.factory = value;
    }
  } else {
    const expectedFactory = expectedBox.factory as Record<string, unknown>;
    for (const [k, v] of Object.entries(fields)) {
      if (v === null) {
        after = removeProperty(after, jsonc, factoryPointer, k);
        delete expectedFactory[k];
      } else if (!isDeepStrictEqual(expectedFactory[k], v)) {
        after = setProperty(after, jsonc, factoryPointer, k, v);
        expectedFactory[k] = v;
      }
    }
  }
  const reread = parseJsonText(after, { jsonc });
  if (!reread.ok || !isDeepStrictEqual(reread.value, expected)) {
    // An edit that does not read back as the value meant is never written.
    throw new Error(`box factory set: editing ${declaration.file} in place did not give the declaration intended; nothing was written`);
  }
  let next: Declaration;
  try {
    next = parseDeclaration(after, declaration.file);
  } catch (err) {
    if (err instanceof WorkspaceReadError) throw new FactoryWriteError("write-input-invalid", `the factory would make the declaration invalid: ${err.describe()}`);
    throw err;
  }
  const nextMember = next.members.find((m) => m.name === member.name)!;

  // The write scope at base, and who --by names.
  const source = scopeSource(req.cwd);
  if (req.by !== undefined) refuseUnidentified(source, [req.by], "--by", { agent: req.agent });
  if (after !== before && (source.declaration !== null || (req.agent !== undefined && req.agent !== ""))) {
    const writer = resolveWriter(source.declaration, source.policy, { agent: req.agent || null, principal: req.by ?? null }, source.classes);
    const unknown = unknownClassVerdict(source.declaration, writer, source.classes);
    if (!unknown.ok) throw new WriteScopeError(unknown.code, unknown.message);
    const verdict = judgePath(source.declaration, writer, declaration.file, { before: () => before, after: () => after });
    if (!verdict.ok) throw new FactoryWriteError(verdict.code as BoxFactoryErrorCode, verdict.message);
  }

  const changed = after !== before;
  if (changed && !req.dryRun) writeAtomically(declFile, after);
  return {
    ...head,
    member: member.name,
    declaration: { path: declPath, sha256: sha256(after) },
    paths: changed ? [declPath] : [],
    changed,
    dryRun: req.dryRun === true,
    previous: factoryView(member.box.factory, declaration.members),
    factory: factoryView(nextMember.box!.factory, next.members),
  };
}
