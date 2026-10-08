/**
 * `chant workspace member add|remove` and `chant workspace host set` (#3596):
 * a declaration's members and hosts, written through chant.
 *
 * ws-074 lets a tool write the repo only through chant. A local lobby keeps
 * one member per box it runs, each with a box block whose isolation chant
 * resolves, and the host those boxes run on; before these writes it edited
 * `chant.workspace.json` itself to plant, retire and start a box. Each write
 * changes one entry of `members` or `hosts` in place, so the file keeps its
 * formatting, key order and, in a `.jsonc` file, its comments, as `box
 * listing set` does (#3308).
 *
 * A write is refused, and nothing written, when the declaration it would
 * write does not read (`write-input-invalid`, with the read's own message),
 * when it adds a collision between two boxes on one host or a literal
 * machine path (`box-isolation-collision`, `box-isolation-literal`, the codes
 * `chant workspace check` reports as WSP123 and WSP124), and when the write
 * scope at base keeps the writer off the declaration (`judgePath`, with the
 * change, so a protected entry's `except` can allow `members` or `hosts`).
 * Each holds the working tree's write lock (#3173, ws-089), prints one JSON
 * document (`member-write.schema.json`) and never commits.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { boxCollisions, boxLiterals } from "./box-isolation";
import { parseDeclaration, readDeclaration, readerVersion, WORKSPACE_ERROR_CODES, WorkspaceReadError, type Declaration } from "./declaration";
import { IDENTITY_CODES, IdentityError, refuseUnidentified } from "./identity";
import { appendElement, removeElement, setElement, setProperty, valueAt } from "./json-edit";
import { parseJsonText } from "./jsonc";
import type { ReasonCode } from "./reason-codes";
import { locateWorkspace } from "./which-chant";
import { judgePath, resolveWriter, scopeSource, unknownClassVerdict, WriteScopeError } from "./write-scope";
import { withWriteLockSync, WriteLockError, WRITE_LOCK_CODES } from "./write-lock";

/** The version of the document these writes print. */
export const DECLARATION_WRITE_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for what the member and host writes print, shipped beside this file. */
export const DECLARATION_WRITE_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/member-write/v1/member-write.schema.json";

/** The writes. */
export const DECLARATION_WRITE_ACTIONS = ["member add", "member remove", "host set"] as const;
export type DeclarationWriteAction = (typeof DECLARATION_WRITE_ACTIONS)[number];

/** Why a member or host write wrote nothing. Closed. */
export const DECLARATION_WRITE_ERROR_CODES = [
  ...WORKSPACE_ERROR_CODES,
  "write-usage-invalid",
  "write-input-invalid",
  "member-exists",
  "member-unknown",
  "box-isolation-collision",
  "box-isolation-literal",
  "write-scope-member",
  "write-scope-protected",
  "write-scope-class-unknown",
  "agent-unknown",
  ...IDENTITY_CODES,
  ...WRITE_LOCK_CODES,
] as const satisfies readonly ReasonCode[];
export type DeclarationWriteErrorCode = (typeof DECLARATION_WRITE_ERROR_CODES)[number];

type Head = { $schema: string; contract: number; chant: string; action: DeclarationWriteAction; name: string | null };

/** What `member add`, `member remove` and `host set` print. */
export type DeclarationWriteDocument =
  | (Head & {
      name: string;
      /** The declaration file, from the repository root, and the sha256 of its bytes after the write (or as it would be, with dryRun). */
      declaration: { path: string; sha256: string };
      /** The declaration, from the repository root, when the write changed it; else empty. */
      paths: string[];
      changed: boolean;
      dryRun: boolean;
      /** The entry before the write, as the file held it, or null when there was none. */
      previous: Record<string, unknown> | null;
      /** The entry after the write, as the file holds it, or null after a remove. */
      entry: Record<string, unknown> | null;
    })
  | (Head & { error: { code: DeclarationWriteErrorCode; message: string } });

export interface DeclarationWriteRequest {
  cwd: string;
  action: DeclarationWriteAction;
  /** The member's or host's name. */
  name: string;
  /** The entry as JSON text (`--from`), for member add and host set. */
  entry?: string;
  /** Who is writing (`--by`). */
  by?: string;
  /** The agent session (`CHANT_AGENT`). */
  agent?: string;
  dryRun?: boolean;
}

class DeclarationWriteError extends Error {
  constructor(
    readonly code: DeclarationWriteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const toPosix = (p: string) => (sep === "/" ? p : p.split(sep).join("/"));
const sha256 = (b: string) => createHash("sha256").update(b).digest("hex");
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The entry given with --from: a JSON object whose name, if it has one, is the one the command names. The name goes first. */
function readEntry(text: string | undefined, req: DeclarationWriteRequest): Record<string, unknown> {
  const what = req.action === "host set" ? "host" : "member";
  if (text === undefined || text.trim() === "") throw new DeclarationWriteError("write-usage-invalid", `${req.action} needs the ${what}'s entry: --from <file|->`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new DeclarationWriteError("write-input-invalid", `the ${what} entry is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObject(value)) throw new DeclarationWriteError("write-input-invalid", `the ${what} entry is a JSON object, as the declaration's ${what}s hold it`);
  if ("name" in value && value.name !== req.name) {
    throw new DeclarationWriteError("write-input-invalid", `the ${what} entry is named ${JSON.stringify(value.name)}, and the command names ${req.name}; leave name out or make them the same`);
  }
  const { name: _name, ...rest } = value;
  return { name: req.name, ...rest };
}

/** Write `text` to `file` through a sibling temporary file, so a reader never sees half of it. */
function writeAtomically(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.chant-${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const collisionKeys = (d: Declaration) =>
  new Map(boxCollisions(d).map((c) => [`${c.host} ${c.what} ${c.value} ${c.holders.map((h) => `${h.box}.${h.name}`).join(",")}`, c]));

/** Run the write and build the document it prints. Never throws for a refusal. */
export function declarationWrite(req: DeclarationWriteRequest): DeclarationWriteDocument {
  const head: Head = { $schema: DECLARATION_WRITE_SCHEMA_ID, contract: DECLARATION_WRITE_CONTRACT_VERSION, chant: readerVersion(), action: req.action, name: req.name || null };
  try {
    return withWriteLockSync(req.cwd, { verb: req.action, by: req.by ?? null, agent: req.agent || null }, req.dryRun, () => write(req, head));
  } catch (err) {
    const fail = (code: DeclarationWriteErrorCode, message: string): DeclarationWriteDocument => ({ ...head, error: { code, message } });
    if (err instanceof DeclarationWriteError) return fail(err.code, err.message);
    if (err instanceof WriteScopeError) return fail(err.code as DeclarationWriteErrorCode, err.message);
    if (err instanceof IdentityError) return fail(err.code, err.message);
    if (err instanceof WriteLockError) return fail(err.code, err.message);
    if (err instanceof WorkspaceReadError) return fail(err.code as DeclarationWriteErrorCode, err.describe());
    throw err;
  }
}

function write(req: DeclarationWriteRequest, head: Head): DeclarationWriteDocument {
  if (!req.name) throw new DeclarationWriteError("write-usage-invalid", `${req.action} needs the name of the ${req.action === "host set" ? "host" : "member"}`);
  if (req.action === "member remove" && req.entry !== undefined) throw new DeclarationWriteError("write-usage-invalid", "member remove takes no --from: it removes the member's whole entry");
  const given = req.action === "member remove" ? null : readEntry(req.entry, req);

  const located = locateWorkspace(req.cwd);
  const declaration = readDeclaration(located.tree);
  const repoBase = located.top ?? located.rootOnDisk;
  const declPath = toPosix(relative(repoBase, join(located.rootOnDisk, declaration.file)));
  const declFile = join(located.rootOnDisk, declaration.file);
  const before = readFileSync(declFile, "utf-8");
  const jsonc = declaration.file.endsWith(".jsonc");
  const parsed = parseJsonText(before, { jsonc });
  if (!parsed.ok) throw new WorkspaceReadError("declaration-unparseable", parsed.message);
  const expected = structuredClone(parsed.value) as Record<string, unknown>;

  // The edit, made twice: in place in the text, and on the parsed value it must read back as.
  let after = before;
  let previous: Record<string, unknown> | null = null;
  if (req.action === "host set") {
    const hosts = valueAt(parsed.value, "/hosts");
    const index = Array.isArray(hosts) ? hosts.findIndex((h) => isObject(h) && h.name === req.name) : -1;
    if (index >= 0) {
      previous = (hosts as Record<string, unknown>[])[index];
      if (!isDeepStrictEqual(previous, given)) {
        after = setElement(after, jsonc, "/hosts", index, given);
        (expected.hosts as unknown[])[index] = given;
      }
    } else if (Array.isArray(hosts)) {
      after = appendElement(after, jsonc, "/hosts", given);
      (expected.hosts as unknown[]).push(given);
    } else {
      after = setProperty(after, jsonc, "", "hosts", [given]);
      expected.hosts = [given];
    }
  } else {
    const entries = valueAt(parsed.value, "/members");
    const list = Array.isArray(entries) ? (entries as unknown[]) : [];
    const index = list.findIndex((e) => isObject(e) && e.name === req.name);
    if (req.action === "member add") {
      if (index >= 0) {
        previous = list[index] as Record<string, unknown>;
        if (!isDeepStrictEqual(previous, given)) {
          throw new DeclarationWriteError("member-exists", `the declaration already has an entry named ${req.name} (/members/${index}); member add writes a new member, so remove that one first or give its entry as it is`);
        }
      } else if (Array.isArray(entries)) {
        after = appendElement(after, jsonc, "/members", given);
        (expected.members as unknown[]).push(given);
      } else {
        after = setProperty(after, jsonc, "", "members", [given]);
        expected.members = [given];
      }
    } else {
      const member = declaration.members.find((m) => m.name === req.name);
      if (!member || index < 0) {
        const isGroup = declaration.groups.some((g) => g.name === req.name);
        throw new DeclarationWriteError(
          "member-unknown",
          isGroup
            ? `${req.name} is an example group, not a member; member remove removes members`
            : `no member is named ${req.name}; the declaration's members are ${declaration.members.map((m) => m.name).join(", ") || "none"}`,
        );
      }
      previous = list[index] as Record<string, unknown>;
      after = removeElement(after, jsonc, "/members", index);
      (expected.members as unknown[]).splice(index, 1);
    }
  }
  const reread = parseJsonText(after, { jsonc });
  if (!reread.ok || !isDeepStrictEqual(reread.value, expected)) {
    // An edit that does not read back as the value meant is never written.
    throw new Error(`${req.action}: editing ${declaration.file} in place did not give the declaration intended; nothing was written`);
  }

  // The declaration it would write reads, and adds no collision or literal path.
  let next: Declaration;
  try {
    next = parseDeclaration(after, declaration.file);
  } catch (err) {
    if (err instanceof WorkspaceReadError) throw new DeclarationWriteError("write-input-invalid", `the ${req.action} would make the declaration invalid: ${err.describe()}`);
    throw err;
  }
  const had = collisionKeys(declaration);
  const added = [...collisionKeys(next)].filter(([k]) => !had.has(k)).map(([, c]) => c);
  if (added.length > 0) {
    const c = added[0];
    throw new DeclarationWriteError(
      "box-isolation-collision",
      `the ${req.action} would give ${c.holders.map((h) => `${h.box}.${h.name}`).join(" and ")} the same ${c.what} ${c.value} on host ${c.host}; give the box a slot no other box holds`,
    );
  }
  const literalsBefore = new Set(boxLiterals(declaration).map((l) => l.message));
  const literal = boxLiterals(next).find((l) => !literalsBefore.has(l.message));
  if (literal) throw new DeclarationWriteError("box-isolation-literal", `the ${req.action} would add a literal machine path: ${literal.message}`);

  // The write scope at base, and who --by names.
  const source = scopeSource(req.cwd);
  if (req.by !== undefined) refuseUnidentified(source, [req.by], "--by", { agent: req.agent });
  if (after !== before && (source.declaration !== null || (req.agent !== undefined && req.agent !== ""))) {
    const writer = resolveWriter(source.declaration, source.policy, { agent: req.agent || null, principal: req.by ?? null }, source.classes);
    const unknown = unknownClassVerdict(source.declaration, writer, source.classes);
    if (!unknown.ok) throw new WriteScopeError(unknown.code, unknown.message);
    const verdict = judgePath(source.declaration, writer, declaration.file, { before: () => before, after: () => after });
    if (!verdict.ok) throw new DeclarationWriteError(verdict.code as DeclarationWriteErrorCode, verdict.message);
  }

  const changed = after !== before;
  if (changed && !req.dryRun) writeAtomically(declFile, after);
  return {
    ...head,
    name: req.name,
    declaration: { path: declPath, sha256: sha256(after) },
    paths: changed ? [declPath] : [],
    changed,
    dryRun: req.dryRun === true,
    previous,
    entry: given,
  };
}
