/**
 * Template migrations (#2550, D9).
 *
 * A template ships its migrations beside its files, under
 * `.chant/migrations/`, one JSON file each. The metadata is data: an id, the
 * template versions it applies `from` (a template id and a version range), the
 * version it brings the scope `to`, a body, and a post-condition. The body is
 * either a closed list of declarative steps or a module, marked
 * `"type": "code"`, which runs only when the caller allows code.
 *
 * `chant workspace upgrade` plans a chain from the scope's version to the
 * target: every migration whose `to` lies in between, ordered by `to`. Each
 * must accept the version the scope has reached when its turn comes. When one
 * does not, a migration is missing from the chain, and the upgrade is refused
 * rather than applied in part.
 *
 * Migrations run inside the upgrade's staging worktree, before the per-file
 * merge. A `move` or `delete` updates the lineage too, so the merge that
 * follows compares the right merge base with the new version.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { LockError, type Lineage } from "./lineage-lock";
import { compareVersions, formatVersion, parseVersion, satisfies, validateRange, VersionRangeError, type Version } from "./lineage-version";

/** Where a template keeps its migrations, relative to the template's directory. */
export const MIGRATIONS_DIR = ".chant/migrations";

const RelPath = z
  .string()
  .min(1)
  .refine((p) => {
    const n = posix.normalize(p);
    return !n.startsWith("/") && n !== ".." && !n.startsWith("../") && !p.includes("\\");
  }, "must be a relative path inside the scope");

/** The declarative steps. Closed: a step chant does not know is refused. */
const StepSchema = z.discriminatedUnion("op", [
  /** Move a file. The lineage entry moves with it, merge base included. */
  z.strictObject({ op: z.literal("move"), from: RelPath, to: RelPath }),
  /** Delete a file and drop it from the lineage. */
  z.strictObject({ op: z.literal("delete"), path: RelPath }),
  /** Replace every occurrence of a literal string in a file. */
  z.strictObject({ op: z.literal("replace"), path: RelPath, find: z.string().min(1), with: z.string() }),
  /** Set a value in a JSON file at a JSON Pointer, creating objects on the way. */
  z.strictObject({ op: z.literal("json-set"), path: RelPath, pointer: z.string().startsWith("/"), value: z.unknown() }),
  /** Remove a key from a JSON file at a JSON Pointer. */
  z.strictObject({ op: z.literal("json-delete"), path: RelPath, pointer: z.string().startsWith("/") }),
]);
export type MigrationStep = z.infer<typeof StepSchema>;

/** What must hold after a migration ran. Every check must pass. */
const PostSchema = z.discriminatedUnion("check", [
  z.strictObject({ check: z.literal("exists"), path: RelPath }),
  z.strictObject({ check: z.literal("absent"), path: RelPath }),
  z.strictObject({ check: z.literal("contains"), path: RelPath, text: z.string().min(1) }),
  z.strictObject({ check: z.literal("not-contains"), path: RelPath, text: z.string().min(1) }),
]);
export type MigrationCheck = z.infer<typeof PostSchema>;

const Range = z.string().min(1).superRefine((r, ctx) => {
  try {
    validateRange(r);
  } catch (err) {
    ctx.addIssue({ code: "custom", message: err instanceof VersionRangeError ? err.message : String(err) });
  }
});

const MigrationSchema = z.strictObject({
  $schema: z.string().optional(),
  /** Unique within the template. Recorded in the lock once applied. */
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "letters, digits, '.', '_' and '-'"),
  description: z.string().optional(),
  from: z.strictObject({
    /** The template id the migration applies to. Omitted, it applies to the template it ships in. */
    template: z.string().min(1).optional(),
    /** The versions it can be applied to. */
    versions: Range,
  }),
  /** The version the scope is at once the migration ran. */
  to: z.string().refine((v) => parseVersion(v) !== null, "must be a version, such as 2.0.0"),
  body: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("declarative"), steps: z.array(StepSchema).min(1) }),
    /**
     * Code: a module in the migrations directory whose default export is
     * `async ({ dir }) => void`, run with the scope directory as `dir`.
     */
    z.strictObject({ type: z.literal("code"), module: RelPath }),
  ]),
  post: z.array(PostSchema).default([]),
});
export type Migration = z.infer<typeof MigrationSchema>;

export class MigrationError extends LockError {
  override name = "MigrationError";
}

export interface LoadedMigration {
  migration: Migration;
  /** The file it was read from, relative to the template directory. */
  file: string;
}

/**
 * Read the migrations out of a template's files (relative path to bytes).
 * Returns them and the files that remain once `.chant/migrations/` is taken
 * out: migrations are the template's, never copied into a project.
 */
export function splitMigrations(files: Map<string, Buffer>): { migrations: LoadedMigration[]; modules: Map<string, Buffer>; files: Map<string, Buffer> } {
  const rest = new Map<string, Buffer>();
  const migrations: LoadedMigration[] = [];
  const modules = new Map<string, Buffer>();
  const prefix = `${MIGRATIONS_DIR}/`;
  for (const [path, data] of files) {
    if (!path.startsWith(prefix)) {
      rest.set(path, data);
      continue;
    }
    const rel = path.slice(prefix.length);
    if (!rel.endsWith(".json")) {
      modules.set(rel, data);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString("utf-8"));
    } catch (err) {
      throw new MigrationError(`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = MigrationSchema.safeParse(raw);
    if (!parsed.success) {
      throw new MigrationError(
        `invalid migration ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
      );
    }
    migrations.push({ migration: parsed.data, file: path });
  }
  const ids = new Set<string>();
  for (const { migration, file } of migrations) {
    if (ids.has(migration.id)) throw new MigrationError(`migration id "${migration.id}" is used twice (${file})`);
    ids.add(migration.id);
    if (migration.body.type === "code" && !modules.has(migration.body.module)) {
      throw new MigrationError(`${file}: its code module ${MIGRATIONS_DIR}/${migration.body.module} is not in the template`);
    }
  }
  return { migrations, modules, files: rest };
}

// ── Planning ─────────────────────────────────────────────────────────────────

export interface MigrationPlan {
  /** In the order they run. */
  chain: LoadedMigration[];
  from: Version | null;
  to: Version | null;
}

/**
 * The migrations that take `lineage` from its version to `targetRef`, in order.
 *
 * With `switchTo`, the upgrade also moves the scope to another template, the
 * one with that id (#2551). The chain then starts with a bridge migration: one
 * the new template ships whose `from.template` names the scope's current
 * template and whose `from.versions` accepts the scope's version. Its `to` is a
 * version of the new template, and the new template's own migrations carry on
 * from there. This is how a fork-born scope, adopted against the fork, comes
 * forward onto the template the fork came from.
 *
 * Refused, with a {@link MigrationError}:
 * - a target below the scope's version (without a switch: versions of two
 *   templates do not compare);
 * - a pending migration when either end of the upgrade is not a version, so
 *   no chain can be computed;
 * - a gap: a migration in range whose `from` does not accept the version the
 *   scope has reached by then;
 * - a switch with no bridge from the scope's version, when the new template
 *   has migrations of its own, since the scope's place in its history is
 *   then unknown.
 */
export function planMigrations(lineage: Lineage, targetRef: string | undefined, available: LoadedMigration[], switchTo?: string): MigrationPlan {
  const from = parseVersion(lineage.ref);
  const to = parseVersion(targetRef);
  const applied = new Set(lineage.migrations);
  const switching = switchTo !== undefined && switchTo !== lineage.template;
  if (!switching && from && to && compareVersions(to, from) < 0) {
    throw new MigrationError(`the target ${targetRef} (${formatVersion(to)}) is older than the scope's ${lineage.ref} (${formatVersion(from)}); an upgrade only goes forward`);
  }
  const target = switching ? switchTo : lineage.template;
  const own = available.filter(({ migration: m }) => (m.from.template === undefined || m.from.template === target) && !applied.has(m.id));
  const bridges = switching ? available.filter(({ migration: m }) => m.from.template === lineage.template && !applied.has(m.id)) : [];
  if (own.length === 0 && bridges.length === 0) return { chain: [], from, to };

  if (!from || !to) {
    const pending = [...bridges, ...own];
    const which = !from ? `the scope's ref ${lineage.ref ?? "(none)"}` : `the target ${targetRef ?? "(none)"}`;
    throw new MigrationError(
      `the template has ${pending.length} migration(s) not yet applied (${pending.map((m) => m.migration.id).join(", ")}), but ${which} is not a version, so no chain can be planned. Pin tagged versions, such as v1.2.0.`,
    );
  }

  let at = from;
  const chain: LoadedMigration[] = [];
  if (switching) {
    // The bridge: the one that accepts the scope's version and lands furthest without passing the target.
    const fits = bridges
      .map((m) => ({ ...m, target: parseVersion(m.migration.to)! }))
      .filter((m) => satisfies(from, m.migration.from.versions) && compareVersions(m.target, to) <= 0)
      .sort((a, b) => compareVersions(b.target, a.target) || a.migration.id.localeCompare(b.migration.id));
    if (fits.length === 0) {
      if (own.length === 0) return { chain: [], from, to };
      throw new MigrationError(
        `moving scope from ${lineage.template} to ${switchTo} needs a bridge migration: one in ${switchTo} with from.template "${lineage.template}" whose from.versions accepts ${formatVersion(from)}${bridges.length > 0 ? ` (found ${bridges.map((m) => `${m.migration.id}: ${m.migration.from.versions}`).join(", ")})` : ""}. Without it the scope's place in ${switchTo}'s history is unknown, so the upgrade is refused.`,
      );
    }
    chain.push({ migration: fits[0].migration, file: fits[0].file });
    at = fits[0].target;
  }

  const inRange = own
    .map((m) => ({ ...m, target: parseVersion(m.migration.to)! }))
    .filter((m) => compareVersions(m.target, at) > 0 && compareVersions(m.target, to) <= 0)
    .sort((a, b) => compareVersions(a.target, b.target) || a.migration.id.localeCompare(b.migration.id));

  let i = 0;
  while (i < inRange.length) {
    const step = inRange[i].target;
    const group = inRange.filter((m) => compareVersions(m.target, step) === 0);
    for (const m of group) {
      if (!satisfies(at, m.migration.from.versions)) {
        throw new MigrationError(
          `gap in the migration chain: ${m.migration.id} (${m.file}) upgrades ${m.migration.from.versions} to ${m.migration.to}, but the scope is at ${formatVersion(at)} when it would run. A migration that brings ${formatVersion(at)} into ${m.migration.from.versions} is missing, so the upgrade is refused.`,
        );
      }
      chain.push({ migration: m.migration, file: m.file });
    }
    at = step;
    i += group.length;
  }
  return { chain, from, to };
}

// ── Running ──────────────────────────────────────────────────────────────────

export interface RunMigrationOptions {
  /** The scope directory in the staging worktree. */
  dir: string;
  lineage: Lineage;
  /** Code modules from the template, relative to its migrations directory. */
  modules: Map<string, Buffer>;
  /** Run `"type": "code"` bodies. Without it, a chain holding one is refused. */
  allowCode: boolean;
  /** Where a code module is written before it is imported. */
  scratch: string;
  /** Told of each file a declarative step moves, so a caller keyed by path (the merge base) can follow. */
  onMove?: (from: string, to: string) => void;
}

/** Refuse a chain holding code when code is not allowed, before anything runs. */
export function assertCodeAllowed(chain: LoadedMigration[], allowCode: boolean): void {
  const code = chain.filter((m) => m.migration.body.type === "code");
  if (code.length > 0 && !allowCode) {
    throw new MigrationError(
      `the chain includes ${code.length} code migration(s) (${code.map((m) => m.migration.id).join(", ")}), which run the template's own code. Read them, then pass --allow-code to run them.`,
    );
  }
}

/** Run one migration in the worktree, then its post-condition. Updates `lineage`. */
export async function runMigration(m: LoadedMigration, opts: RunMigrationOptions): Promise<void> {
  const { migration } = m;
  const body = migration.body;
  if (body.type === "code") {
    if (!opts.allowCode) throw new MigrationError(`${migration.id} is a code migration; pass --allow-code to run it`);
    const file = join(opts.scratch, "migrations", body.module);
    mkdirSync(dirname(file), { recursive: true });
    for (const [rel, data] of opts.modules) {
      const abs = join(opts.scratch, "migrations", rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, data);
    }
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    if (typeof mod.default !== "function") throw new MigrationError(`${migration.id}: ${body.module} has no default export function`);
    await (mod.default as (ctx: { dir: string }) => unknown)({ dir: opts.dir });
  } else {
    for (const step of body.steps) {
      applyStep(step, opts.dir, opts.lineage, migration.id);
      if (step.op === "move") opts.onMove?.(step.from, step.to);
    }
  }
  const failed = migration.post.filter((c) => !holds(c, opts.dir));
  if (failed.length > 0) {
    throw new MigrationError(
      `migration ${migration.id} ran, but its post-condition does not hold: ${failed.map(describeCheck).join("; ")}. The upgrade is refused.`,
    );
  }
  opts.lineage.migrations.push(migration.id);
}

function applyStep(step: MigrationStep, dir: string, lineage: Lineage, id: string): void {
  const abs = (p: string) => join(dir, p);
  const need = (p: string) => {
    if (!existsSync(abs(p))) throw new MigrationError(`migration ${id}: ${step.op} needs ${p}, which is not in the scope`);
  };
  switch (step.op) {
    case "move": {
      need(step.from);
      if (existsSync(abs(step.to))) throw new MigrationError(`migration ${id}: cannot move ${step.from} to ${step.to}, which exists`);
      mkdirSync(dirname(abs(step.to)), { recursive: true });
      renameSync(abs(step.from), abs(step.to));
      const entry = lineage.files[step.from];
      if (entry) {
        delete lineage.files[step.from];
        lineage.files[step.to] = entry;
      }
      return;
    }
    case "delete":
      if (existsSync(abs(step.path))) rmSync(abs(step.path));
      delete lineage.files[step.path];
      return;
    case "replace": {
      need(step.path);
      const text = readFileSync(abs(step.path), "utf-8");
      writeFileSync(abs(step.path), text.split(step.find).join(step.with));
      return;
    }
    case "json-set":
    case "json-delete": {
      need(step.path);
      let doc: unknown;
      try {
        doc = JSON.parse(readFileSync(abs(step.path), "utf-8"));
      } catch {
        throw new MigrationError(`migration ${id}: ${step.path} is not valid JSON`);
      }
      const keys = step.pointer.slice(1).split("/").map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
      const last = keys.pop()!;
      let node = doc as Record<string, unknown>;
      for (const k of keys) {
        if (typeof node[k] !== "object" || node[k] === null) {
          if (step.op === "json-delete") return;
          node[k] = {};
        }
        node = node[k] as Record<string, unknown>;
      }
      if (step.op === "json-set") node[last] = step.value;
      else delete node[last];
      writeFileSync(abs(step.path), JSON.stringify(doc, null, 2) + "\n");
      return;
    }
  }
}

function holds(c: MigrationCheck, dir: string): boolean {
  const abs = join(dir, c.path);
  switch (c.check) {
    case "exists":
      return existsSync(abs);
    case "absent":
      return !existsSync(abs);
    case "contains":
      return existsSync(abs) && readFileSync(abs, "utf-8").includes(c.text);
    case "not-contains":
      return !existsSync(abs) || !readFileSync(abs, "utf-8").includes(c.text);
  }
}

function describeCheck(c: MigrationCheck): string {
  return "text" in c ? `${c.check} ${JSON.stringify(c.text)} in ${c.path}` : `${c.path} ${c.check}`;
}
