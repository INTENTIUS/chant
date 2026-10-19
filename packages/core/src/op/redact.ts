/**
 * Redaction of secret values (#4096): what a run writes about itself, with
 * each secret value replaced by `***`.
 *
 * The executor (./local-executor.ts) takes a {@link Redact} and applies it
 * where a run writes: each run-event line, each line a step prints, and the
 * run record before it is signed and stored. `chant ci run` builds one from
 * the host's secrets file and the job's secret-looking variables
 * (../workspace/ci-secrets.ts).
 *
 * A value shorter than {@link REDACT_MIN_LENGTH} characters is not
 * redacted: a two- or three-character value matches too much ordinary text.
 */

/** What every redacted value is replaced with. */
export const REDACTED = "***";

/** The shortest value redacted. Shorter values are left as they are. */
export const REDACT_MIN_LENGTH = 4;

/** A text with every secret value it contains replaced by {@link REDACTED}. */
export type Redact = (text: string) => string;

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The redactor for `values`, or undefined when none is long enough to
 * redact. A value that spans lines is also redacted line by line, since
 * step output reaches a reader one line at a time.
 */
export function redactorOf(values: Iterable<string>): Redact | undefined {
  const all = new Set<string>();
  const add = (v: string): void => {
    if (v.length < REDACT_MIN_LENGTH) return;
    all.add(v);
    // As a JSON string spells it, for a value with a quote, a backslash or a control character in it.
    all.add(JSON.stringify(v).slice(1, -1));
  };
  for (const value of values) {
    add(value);
    if (value.includes("\n")) for (const line of value.split(/\r?\n/)) add(line.trim());
  }
  if (all.size === 0) return undefined;
  // Longest first, so a value that contains another is replaced whole.
  const pattern = new RegExp([...all].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"), "g");
  return (text) => (typeof text === "string" && text.length >= REDACT_MIN_LENGTH ? text.replace(pattern, REDACTED) : text);
}

/** `value` with `redact` applied to every string in it, keys included. Numbers, booleans and nulls are kept. */
export function redactDeep<T>(value: T, redact: Redact): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[redact(k)] = redactDeep(v, redact);
    return out as T;
  }
  return value;
}

/**
 * A JSON value's text, as `JSON.stringify` wrote it, with `redact` applied to
 * its strings: parsed, redacted and written again, so a short value such as
 * `true` that is also a secret doesn't break the document. Undefined when
 * `text` is not JSON.
 */
function redactJsonText(text: string, redact: Redact): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const indent = /^[[{]\r?\n(\s+)/.exec(text)?.[1]?.length;
  const trailing = /\s*$/.exec(text)?.[0] ?? "";
  return `${JSON.stringify(redactDeep(parsed, redact), null, indent)}${trailing}`;
}

/**
 * A file's or line's text redacted: a JSON document as JSON, each line of a
 * JSON Lines text as JSON, and any other text, or line, as text. The text
 * comes back unchanged when it holds no secret.
 */
export function redactText(text: string, redact: Redact): string {
  if (redact(text) === text) return text;
  const whole = redactJsonText(text, redact);
  if (whole !== undefined) return whole;
  return text
    .split("\n")
    .map((line) => (redact(line) === line ? line : (redactJsonText(line, redact) ?? redact(line))))
    .join("\n");
}
