/**
 * Review sessions (#2673, #2650 C10): a record kind whose records are the
 * sessions a group reviewed records in. A session kind names, in its
 * `session` declaration, the list of verdicts a session produced, the field
 * that seals it once closed, and the kind file of the records its verdicts
 * name (the subjects, such as decisions).
 *
 * On read, a closed session's seal has to match its text
 * (`session-seal-mismatch`), and each verdict has to name a subject record
 * that exists (`session-verdict-unknown-record`). Each session also lists the
 * subjects' review entries that name it in their `session` field, as
 * `citedBy`. This module only reads; nothing here writes a seal into a file.
 */

import { recordTextDigest, type RecordEntry, type RecordKind } from "./records";

/** A subject record's review entry that names a session in its `session` field. */
export interface SessionCitation {
  /** The subject record's id. */
  id: string;
  /** The subject record's path, from the repository root. */
  path: string;
  /** The entry's position in the subject's reviews list, from 0. */
  index: number;
  /** The reviewer as the entry writes it, or null when it names none. */
  reviewer: string | null;
  /** The verdict as the entry writes it, or null when it names none. */
  verdict: string | null;
}

/**
 * The seal of a session record: {@link recordTextDigest} with the seal field
 * in place of the reviews list. That is the lowercase hex SHA-256 of the
 * file's text with LF line endings and without the front-matter line that
 * holds the seal, a quoted string on one line. Every other byte, the `---`
 * lines and the body included, is kept.
 *
 * `awk 'NR==1&&/^---$/{f=1;print;next} f&&/^---$/{f=0} f&&/^closed_digest:/{next} {print}' S-0001.md | shasum -a 256`
 * gives the same value for a file with LF line endings that ends in one.
 */
export function sessionSeal(text: string, field: string): string {
  return recordTextDigest(text, field);
}

/**
 * Check each session in `entries` against its seal and the subject records,
 * and fill in `citedBy`. `texts` holds each entry's file text by path.
 * `subjects` holds the subject records and the name of their reviews list;
 * it is null when they were not read, and then no verdict is checked.
 */
export function joinSessions(kind: RecordKind, entries: RecordEntry[], texts: Map<string, string>, subjects: { records: RecordEntry[]; reviews: string } | null): void {
  const decl = kind.session;
  if (!decl) return;
  const closed = new Set(kind.closedStates);
  const subjectIds = new Set(subjects?.records.map((s) => s.id).filter((id): id is string => id !== null) ?? []);
  const citations = new Map<string, SessionCitation[]>();
  for (const s of subjects?.records ?? []) {
    if (s.id === null) continue;
    const reviews = s.data?.[subjects!.reviews];
    if (!Array.isArray(reviews)) continue;
    reviews.forEach((r, index) => {
      if (r === null || typeof r !== "object") return;
      const entry = r as Record<string, unknown>;
      if (typeof entry.session !== "string") return;
      const list = citations.get(entry.session) ?? [];
      list.push({
        id: s.id!,
        path: s.path,
        index,
        reviewer: typeof entry.reviewer === "string" ? entry.reviewer : null,
        verdict: typeof entry.verdict === "string" ? entry.verdict : null,
      });
      citations.set(entry.session, list);
    });
  }
  for (const e of entries) {
    e.citedBy = e.id === null ? [] : (citations.get(e.id) ?? []);
    if (e.data === null) continue;
    if (e.state !== null && closed.has(e.state)) {
      const seal = e.data[decl.seal];
      const text = texts.get(e.path);
      if (typeof seal === "string" && text !== undefined) {
        const actual = sessionSeal(text, decl.seal);
        if (actual !== seal) {
          e.reasons.push({
            code: "session-seal-mismatch",
            message: `${decl.seal} is ${seal}, but the text hashes to ${actual}: the session changed after it closed`,
          });
        }
      }
    }
    if (subjects === null) continue;
    const verdicts = e.data[decl.verdicts];
    if (!Array.isArray(verdicts)) continue;
    verdicts.forEach((v, i) => {
      if (v === null || typeof v !== "object") return;
      const record = (v as Record<string, unknown>).record;
      if (typeof record === "string" && !subjectIds.has(record)) {
        e.reasons.push({ code: "session-verdict-unknown-record", message: `${decl.verdicts}[${i}] names ${record}, which no ${decl.subjects.kind} record has` });
      }
    });
  }
}
