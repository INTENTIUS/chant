/**
 * A state migration's history, read back from the lines chant wrote
 * (chant#4910): each `finished` line of the migration's gated requests
 * (`_gates/<op>/applied.jsonl` on `chant/lifecycle`, written by core's
 * `runStateMigration` with `migrationFacts`), as one history line per run,
 * and the revert of a migration that applied, each root back to the version
 * the migration recorded before it wrote.
 *
 * The history line is the form terragucci's `done.jsonl` has always held,
 * so a product that kept such a file before chant ran its gate reads the two
 * together ({@link migrationHistory}). Besides core's facts, a finished
 * line's detail may carry the product's `file_digest`, its change
 * (`migration_change`, else `change`) and the migration a revert put back
 * (`revert`); they are read when there.
 *
 * Lifted from terragucci's `finishedMigrationLines`, `migrationHistory` and
 * `revertMigration` (migrate.ts), so terragucci deletes its copies and keeps
 * its file's words.
 */
import { MigrationError, type Restore } from "./state-migration";

/** One root of a history line: where its state is, and its version and digest before and after. */
export interface MigrationHistoryRoot {
  root: string;
  location: string | null;
  before: string | null;
  after: string | null;
  before_digest: string | null;
  after_digest: string | null;
  /** A backend move's source, and the version read there. */
  source?: string | null;
  source_version?: string | null;
}

/** One run of a migration, as its history holds it. */
export interface MigrationHistoryLine {
  version: 1;
  kind: "migration";
  op: string;
  /** The migration's name. */
  gate: string;
  timestamp: string;
  planDigest?: string;
  file_digest?: string;
  /** `applied` or `failed`. A run refused under the locks wrote nothing and has no line. */
  result: string;
  approvedBy?: string;
  /** The migration's change: `moves`, `backends`, `revert`, `retag`, `adopt`, as the product's detail names it. */
  change: string | null;
  /** The migration a revert put back. */
  revert?: string;
  roots: MigrationHistoryRoot[];
  error?: string;
  /** `finished`: read from a gated request's finished line. */
  source?: string;
}

/**
 * The finished lines of a migration op's `applied.jsonl` as history lines,
 * oldest first. A line without a `result` is skipped (the migration threw
 * before it ended), and so is a run refused under the lock, which wrote
 * nothing.
 */
export function finishedMigrationLines(appliedText: string, op: string): MigrationHistoryLine[] {
  const out: MigrationHistoryLine[] = [];
  for (const l of appliedText.split("\n").map((x) => x.trim()).filter(Boolean)) {
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(l) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (r.version !== 1 || r.kind !== "finished" || typeof r.gate !== "string" || typeof r.timestamp !== "string") continue;
    const d = r.detail && typeof r.detail === "object" ? (r.detail as Record<string, unknown>) : {};
    if (typeof d.result !== "string" || d.result === "refused") continue;
    const str = (k: string): string | null => (typeof d[k] === "string" ? (d[k] as string) : null);
    const roots = (str("roots") ?? "")
      .split(",")
      .filter(Boolean)
      .map((root): MigrationHistoryRoot => ({
        root,
        location: str(`${root}.location`),
        before: str(`${root}.before`),
        after: str(`${root}.after`),
        before_digest: str(`${root}.before_digest`),
        after_digest: str(`${root}.after_digest`),
        ...(str(`${root}.source`) ? { source: str(`${root}.source`), source_version: str(`${root}.source_version`) } : {}),
      }));
    out.push({
      version: 1,
      kind: "migration",
      op,
      gate: r.gate,
      timestamp: r.timestamp,
      ...(typeof r.planDigest === "string" ? { planDigest: r.planDigest } : {}),
      ...(str("file_digest") ? { file_digest: str("file_digest")! } : {}),
      result: d.result,
      ...(str("approved_by") ? { approvedBy: str("approved_by")! } : {}),
      change: str("migration_change") ?? str("change"),
      ...(str("revert") ? { revert: str("revert")! } : {}),
      roots,
      ...(str("error") ? { error: str("error")! } : {}),
      source: "finished",
    });
  }
  return out;
}

/** Where a migration op's history is kept on `chant/lifecycle`: chant's `applied.jsonl`, and the product's own earlier file, if it kept one. */
export interface MigrationHistoryFiles {
  op: string;
  /** The product's file of history lines written before chant ran the gate, such as `_gates/tf-migrate/done.jsonl`. */
  earlier?: string;
}

/**
 * A migration op's history as history-line text, one JSON line each: the
 * product's earlier lines first, then each finished line of chant's gated
 * requests. The newest line of a migration wins. `show` reads a path on
 * `chant/lifecycle` as the caller wants it read (the remote ref as last
 * fetched, say), answering "" for a path that is not there.
 */
export function migrationHistory(show: (path: string) => string, files: MigrationHistoryFiles): string {
  const earlier = files.earlier ? show(files.earlier).split("\n").map((l) => l.trim()).filter(Boolean) : [];
  const finished = finishedMigrationLines(show(`_gates/${files.op}/applied.jsonl`), files.op).map((l) => JSON.stringify(l));
  return [...earlier, ...finished].join("\n") + "\n";
}

/** The newest line of each migration that ran its writes, by name. */
export function doneMigrations(history: string): Map<string, { status: string; file_digest?: string; timestamp: string }> {
  const out = new Map<string, { status: string; file_digest?: string; timestamp: string }>();
  for (const line of history.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const r = JSON.parse(line) as Record<string, unknown>;
      if (r.kind !== "migration" || typeof r.gate !== "string" || typeof r.timestamp !== "string") continue;
      out.set(r.gate, { status: String(r.result), ...(typeof r.file_digest === "string" ? { file_digest: r.file_digest } : {}), timestamp: r.timestamp });
    } catch {
      continue;
    }
  }
  return out;
}

/** The name a revert of `name` takes. */
export const revertName = (name: string): string => `${name}-revert`;

/** A revert of a migration that applied: its name, each root's restore, and the migration file that asks for it. */
export interface MigrationRevert {
  name: string;
  restores: Restore[];
  /** The file, `revert:` and `restores:`, under the caller's comment lines. */
  text: string;
}

/**
 * The revert of a migration that applied, from its newest applied line in
 * `history`: each root back to the version the migration recorded before it
 * wrote, from the version it recorded after (the write is refused when a
 * state moved past it). A backend move, a revert, an estate retag or an
 * estate adoption is not put back this way, and a root whose bucket kept no
 * version cannot be put back: each throws {@link MigrationError} naming why.
 * `where` names the history in the refusal; `header` are the file's comment
 * lines, without their `# `.
 */
export function revertMigration(name: string, history: string, options: { where?: string; header?: readonly string[] } = {}): MigrationRevert {
  let line: Record<string, unknown> | undefined;
  for (const l of history.split("\n").map((x) => x.trim()).filter(Boolean)) {
    try {
      const r = JSON.parse(l) as Record<string, unknown>;
      if (r.kind === "migration" && r.gate === name && r.result === "applied") line = r;
    } catch {
      continue;
    }
  }
  if (!line) throw new MigrationError(`chant/lifecycle records no applied migration ${name}${options.where ? `, ${options.where}` : ""}`);
  if (line.change === "backends") throw new MigrationError(`${name} moved states to new backends; put it back with a backend move the other way, which reads each state where it is now`);
  if (line.change === "revert") throw new MigrationError(`${name} is a revert; apply the migration it put back again with a new migration file`);
  if (line.change === "retag") throw new MigrationError(`${name} retagged resources between estates; put it back with a moves migration the other way`);
  if (line.change === "adopt") throw new MigrationError(`${name} adopted a state into an estate and left the state where it was; to go back, put the backend block back in place of the live block`);
  const roots = Array.isArray(line.roots) ? (line.roots as Record<string, unknown>[]) : [];
  const problems: string[] = [];
  const restores: Restore[] = roots.map((r) => {
    const root = String(r.root);
    if (typeof r.location !== "string" || !/^(s3|gs|az):\/\//.test(r.location)) problems.push(`${root}: its backend keeps no versions, so there is no earlier state to put back`);
    if (r.before === null && r.before_digest !== null) problems.push(`${root}: its bucket kept no version before ${name} wrote, so there is no earlier state to put back`);
    if (typeof r.after !== "string") problems.push(`${root}: ${name} recorded no version after its write, so a later change could not be told apart`);
    return { root, location: String(r.location), version_id: typeof r.before === "string" ? r.before : null, from_version_id: typeof r.after === "string" ? r.after : null };
  });
  if (problems.length > 0) throw new MigrationError(`${name} cannot be put back:\n  ${problems.join("\n  ")}`);
  const q = (v: string | null): string => (v === null ? "null" : JSON.stringify(v));
  const text = [
    ...(options.header ?? [`Puts back the states migration ${name} wrote, to the versions it recorded before it wrote them.`]).map((h) => `# ${h}`),
    `revert: ${name}`,
    "restores:",
    ...restores.flatMap((r) => [`  - root: ${r.root}`, `    location: ${r.location}`, `    version_id: ${q(r.version_id)}`, `    from_version_id: ${q(r.from_version_id)}`]),
    "",
  ].join("\n");
  return { name: revertName(name), restores, text };
}
