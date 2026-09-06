/**
 * Cron for an Op's own schedule (#2120) — validation at `Op()` construction
 * and minute-granularity matching for `chant operator`'s per-op cadence.
 *
 * `OpConfig.schedule.cron` is runtime-neutral data: the github lexicon turns
 * it into `on.schedule`, a Temporal project pairs it with a `TemporalSchedule`
 * by hand, `chant operator` reads it as that Op's tick cadence, and the local
 * one-shot executor ignores it entirely. Nothing here talks to a scheduler.
 *
 * The validator is the one TMP010 already used against generated
 * `TemporalSchedule` files (`lexicons/temporal/src/lint/post-synth/tmp010-cron-syntax.ts`,
 * which now imports it from here rather than keeping its own copy):
 * deliberately permissive, a pre-submission guard rather than a full parser,
 * since the final word belongs to whichever scheduler runs the cron.
 *
 * {@link cronMatches} is stricter about what it can *evaluate* than
 * {@link isValidCronExpression} is about what it accepts, so a field carrying
 * a Quartz extension the evaluator does not implement (`L`, `W`, `#`, `?`)
 * matches everything rather than nothing — an operator that ticks too often
 * is a wasted converge, one that never ticks is a silent outage.
 */

/** Very permissive cron field pattern — catches obvious syntax errors. */
const CRON_FIELD = /^[0-9*,/\-?LW#]+$/;

/**
 * True when `expr` looks like 5- or 6-field cron. Field-shape only: it does
 * not check that a number is in range for its position, and it accepts the
 * Quartz extensions (`L`, `W`, `#`, `?`) some schedulers take.
 */
export function isValidCronExpression(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length < 5 || fields.length > 6) return false;
  return fields.every((f) => CRON_FIELD.test(f));
}

/**
 * The message TMP010 reports and `Op()` throws with, so one wording covers
 * both the build-time refusal and the post-synth warning.
 */
export function cronSyntaxMessage(expr: string): string {
  return `cron expression "${expr}" does not look like valid 5- or 6-field cron syntax`;
}

/** A parsed cron field: either "matches anything" or the exact set it matches. */
type FieldSpec = { any: true } | { any: false; values: Set<number> };

const ANY: FieldSpec = { any: true };

/**
 * Parse one field into the set of values it matches. Anything the evaluator
 * cannot make sense of — a Quartz extension, an inverted range, a zero step —
 * degrades to {@link ANY} rather than throwing: this runs on an expression
 * `Op()` already accepted, and refusing at tick time would strand the Op.
 */
function parseField(field: string, min: number, max: number): FieldSpec {
  if (field === "*" || field === "?" || /[LW#]/.test(field)) return ANY;

  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return ANY;

    let lo: number;
    let hi: number;
    if (rangePart === "*" || rangePart === "") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      // `5/10` means "from 5, every 10" — a bare `5` means only 5.
      hi = stepPart === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) return ANY;

    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values.size === 0 ? ANY : { any: false, values };
}

function fieldMatches(spec: FieldSpec, value: number): boolean {
  return spec.any || spec.values.has(value);
}

/**
 * True when `date` falls on a minute `expr` fires at, in the host's local
 * time zone (the only clock the operator daemon has).
 *
 * A 6-field expression is read as Quartz's `second minute hour dom month dow`
 * and the seconds field is dropped — nothing in chant ticks sub-minute.
 * Day-of-month and day-of-week follow the usual cron rule: when both are
 * restricted, either one matching is enough.
 */
export function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  const five = fields.length === 6 ? fields.slice(1) : fields;
  if (five.length !== 5) return false;

  const [minuteF, hourF, domF, monthF, dowF] = five;
  if (!fieldMatches(parseField(minuteF, 0, 59), date.getMinutes())) return false;
  if (!fieldMatches(parseField(hourF, 0, 23), date.getHours())) return false;
  if (!fieldMatches(parseField(monthF, 1, 12), date.getMonth() + 1)) return false;

  const dom = parseField(domF, 1, 31);
  const dow = parseField(dowF, 0, 7);
  const weekday = date.getDay();
  const domOk = fieldMatches(dom, date.getDate());
  const dowOk = fieldMatches(dow, weekday) || (weekday === 0 && fieldMatches(dow, 7));

  if (dom.any && dow.any) return true;
  if (dom.any) return dowOk;
  if (dow.any) return domOk;
  return domOk || dowOk;
}

/**
 * The longest window {@link cronDueBetween} scans minute by minute. Past it
 * the answer is "yes" without scanning: an operator that has not looked at an
 * op for two days has certainly missed a fire of any cron worth putting on an
 * Op, and the alternative — 100k iterations on a clock jump — buys nothing.
 */
const MAX_SCAN_MINUTES = 2 * 24 * 60;

/**
 * True when `expr` fires at some minute in `(after, upTo]` — what a round
 * asks for an Op it last ticked at `after`. Level-triggered on purpose: a
 * round that arrives late still ticks the Op it owes rather than waiting for
 * the next exact match, and several missed fires collapse into the one tick a
 * convergent verb needs.
 */
export function cronDueBetween(expr: string, after: Date, upTo: Date): boolean {
  if (upTo.getTime() <= after.getTime()) return false;

  const startMs = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  if (startMs > upTo.getTime()) return false;

  const spanMinutes = Math.floor((upTo.getTime() - startMs) / 60_000) + 1;
  if (spanMinutes > MAX_SCAN_MINUTES) return true;

  for (let i = 0; i < spanMinutes; i++) {
    if (cronMatches(expr, new Date(startMs + i * 60_000))) return true;
  }
  return false;
}
