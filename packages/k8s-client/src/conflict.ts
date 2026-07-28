/**
 * The server-side-apply conflict surface — chant #1075.
 *
 * When an apply touches a field another manager owns, the API server refuses
 * with a 409 and — unlike almost every other Kubernetes failure — tells you
 * precisely what went wrong: which fields, and who owns each one. It arrives as
 * a `Status` whose `details.causes` is a list of `FieldManagerConflict` entries:
 *
 * ```json
 * { "reason": "Conflict", "code": 409,
 *   "message": "Apply failed with 2 conflicts: conflicts with \"kubectl\" ...",
 *   "details": { "causes": [
 *     { "type": "FieldManagerConflict", "message": "conflict with \"kubectl\"",
 *       "field": ".spec.replicas" } ] } }
 * ```
 *
 * chant #1074 already carried that through as a typed `K8sApiError` with
 * `conflict === true`. What was missing is the presentation: a 409 whose
 * message is one run-on line is not something an operator can act on, and the
 * thing they must not do — force it because the error suggested nothing else —
 * is exactly what a bad message invites.
 *
 * So this error names the competing manager, lists the contested paths under
 * it, says what forcing would mean, and stops there. **chant never forces a
 * conflict on its own.** Taking a field from another manager is a decision
 * about who owns production, and a tool that makes it silently is the reason
 * "it works on my cluster" happens. The opt-in exists (`force`), it is never
 * the default, and nothing in chant turns it on for you.
 */

import { K8sApiError, type K8sStatus } from "./errors";

/** One contested field: a path, and the manager that owns it. */
export interface FieldConflict {
  /** The manager that currently owns the field, e.g. `kubectl`, `helm`. */
  manager: string;
  /**
   * The field path, in the same syntax `./managed-fields.ts` renders — e.g.
   * `.spec.replicas`, `.spec.template.spec.containers[name="web"].image`.
   */
  field: string;
  /** The apiVersion the owning entry was recorded at, when the server said. */
  apiVersion?: string;
}

/**
 * A server-side apply was refused because another field manager owns fields
 * this apply would set.
 *
 * Extends {@link K8sApiError} so every existing `instanceof K8sApiError` check
 * (and the `conflict` predicate) keeps working — this is a presentation of the
 * 409, not a replacement for it.
 */
export class FieldManagerConflictError extends K8sApiError {
  /** Every contested field, in the order the server reported them. */
  public readonly conflicts: FieldConflict[];
  /** The field manager chant applied as, and which was refused. */
  public readonly fieldManager: string;

  constructor(
    statusCode: number,
    apiMessage: string,
    conflicts: FieldConflict[],
    fieldManager: string,
    target?: string,
    status?: K8sStatus,
  ) {
    super(statusCode, status?.reason ?? "Conflict", apiMessage, target, status);
    this.name = "FieldManagerConflictError";
    this.conflicts = conflicts;
    this.fieldManager = fieldManager;
    // Message is assembled after the fields exist, since it renders them.
    this.message = renderConflictReport({ conflicts, fieldManager, target, apiMessage });
  }

  /** Contested paths grouped by the manager that owns them, managers sorted. */
  get byManager(): Record<string, string[]> {
    const grouped: Record<string, string[]> = {};
    for (const conflict of this.conflicts) {
      (grouped[conflict.manager] ??= []).push(conflict.field);
    }
    return Object.fromEntries(
      Object.entries(grouped)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([manager, fields]) => [manager, [...fields].sort()]),
    );
  }

  /** The competing managers, sorted. */
  get managers(): string[] {
    return Object.keys(this.byManager);
  }

  /** The contested paths, sorted and deduplicated. */
  get fields(): string[] {
    return [...new Set(this.conflicts.map((c) => c.field))].sort();
  }
}

/** Inputs {@link renderConflictReport} needs; broken out so tests can render directly. */
export interface ConflictReport {
  conflicts: FieldConflict[];
  fieldManager: string;
  target?: string;
  /** The server's own message, used verbatim when nothing could be parsed. */
  apiMessage?: string;
}

/**
 * The operator-facing rendering. Three things, in this order: what is
 * contested and who holds it, what chant applied as, and what the two ways out
 * actually mean. No recommendation between them — that is the point.
 */
export function renderConflictReport(report: ConflictReport): string {
  const { conflicts, fieldManager, target } = report;
  const subject = target ? `${target}` : "this object";

  if (conflicts.length === 0) {
    return (
      `k8s: server-side apply of ${subject} was refused with a field-ownership conflict, but the ` +
      `API server reported no field causes${report.apiMessage ? ` — it said: ${report.apiMessage}` : ""}. ` +
      `chant applied as field manager "${fieldManager}".`
    );
  }

  const grouped = new Map<string, string[]>();
  for (const conflict of conflicts) {
    const list = grouped.get(conflict.manager) ?? [];
    if (!list.includes(conflict.field)) list.push(conflict.field);
    grouped.set(conflict.manager, list);
  }

  const count = new Set(conflicts.map((c) => c.field)).size;
  const lines = [
    `k8s: server-side apply of ${subject} was refused — ` +
      `${count} ${count === 1 ? "field is" : "fields are"} owned by another field manager.`,
    "",
  ];
  for (const [manager, fields] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  "${manager}" owns:`);
    for (const field of [...fields].sort()) lines.push(`    ${field}`);
  }
  lines.push(
    "",
    `chant applied as field manager "${fieldManager}". Taking these fields means the managers above`,
    `stop owning them, and will contest them again on their next apply.`,
    "",
    "chant does not force this for you. Either:",
    "  - remove the contested fields from your chant source, leaving them to their current owner; or",
    "  - re-run this apply with force-conflicts on, deliberately (the `force: true` activity argument,",
    "    or `forceConflicts: true` on ApplyOp), which transfers ownership to chant.",
  );
  return lines.join("\n");
}

/**
 * Pull the field causes out of a 409 `Status`.
 *
 * `details.causes` is the machine-readable form and is preferred. Not every
 * server fills it in — an aggregated API server or an older release puts the
 * same information only in the prose `message` — so the message is parsed as a
 * fallback rather than the list being reported as empty.
 */
export function parseFieldConflicts(status: K8sStatus | undefined, message?: string): FieldConflict[] {
  const fromCauses = causesOf(status);
  if (fromCauses.length > 0) return fromCauses;
  return parseConflictMessage(message ?? status?.message ?? "");
}

interface StatusCause {
  type?: string;
  message?: string;
  field?: string;
}

function causesOf(status: K8sStatus | undefined): FieldConflict[] {
  const details = status?.details;
  if (!details || typeof details !== "object") return [];
  const causes = (details as { causes?: unknown }).causes;
  if (!Array.isArray(causes)) return [];
  const out: FieldConflict[] = [];
  for (const raw of causes as StatusCause[]) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.type !== undefined && raw.type !== "FieldManagerConflict") continue;
    const field = typeof raw.field === "string" ? raw.field : undefined;
    if (!field) continue;
    const { manager, apiVersion } = parseCauseMessage(raw.message ?? "");
    out.push({
      manager: manager ?? "an unnamed manager",
      field,
      ...(apiVersion ? { apiVersion } : {}),
    });
  }
  return out;
}

/** `conflict with "kubectl" using apps/v1` → manager + apiVersion. */
function parseCauseMessage(message: string): { manager?: string; apiVersion?: string } {
  const manager = /conflicts? with "([^"]+)"/.exec(message)?.[1];
  const apiVersion = /\busing ([^\s:]+)\b/.exec(message)?.[1];
  return { ...(manager ? { manager } : {}), ...(apiVersion ? { apiVersion } : {}) };
}

/**
 * Parse the prose form, which the server builds as one `conflicts with "x"`
 * clause per manager followed by that manager's fields as a `-` list:
 *
 * ```
 * Apply failed with 2 conflicts: conflicts with "kubectl" using apps/v1:
 * - .spec.replicas
 * - .spec.template.spec.containers[name="web"].image
 * ```
 */
export function parseConflictMessage(message: string): FieldConflict[] {
  if (!message) return [];
  const out: FieldConflict[] = [];
  let manager: string | undefined;
  let apiVersion: string | undefined;

  for (const rawLine of message.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    const header = /conflicts? with "([^"]+)"(?: using ([^\s:]+))?/.exec(line);
    if (header) {
      manager = header[1];
      apiVersion = header[2];
      // Single-conflict messages inline the field: `... with "kubectl": .spec.replicas`
      const inline = /:\s*(\.[^\s]+)$/.exec(line);
      if (inline) out.push({ manager, field: inline[1], ...(apiVersion ? { apiVersion } : {}) });
      continue;
    }

    const bullet = /^-\s*(\S.*)$/.exec(line);
    if (bullet && manager) {
      out.push({ manager, field: bullet[1].trim(), ...(apiVersion ? { apiVersion } : {}) });
    }
  }
  return out;
}

/**
 * Turn a 409 from an apply into the presented error. Any other failure is
 * returned unchanged — this is a narrowing, not a catch-all.
 */
export function asFieldManagerConflict(error: unknown, fieldManager: string): unknown {
  if (!(error instanceof K8sApiError) || !error.conflict) return error;
  if (error instanceof FieldManagerConflictError) return error;
  return new FieldManagerConflictError(
    error.statusCode,
    error.apiMessage,
    parseFieldConflicts(error.status, error.apiMessage),
    fieldManager,
    error.target,
    error.status,
  );
}
