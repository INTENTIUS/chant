/**
 * Temporal windows — the one thing dogwood's past-only operators cannot omit.
 *
 * `formerly`, `previous` and `since` all take a mandatory `within <n><unit>`
 * clause; the unit is one of `s`, `m`, `h`, `d` and nothing else. Upstream's
 * `temporal/grammar.pest` spells that out:
 *
 * ```
 * within         = { "within" ~ within_payload }
 * within_payload = { param_ref | (integer ~ time_unit) }
 * time_unit      = { "s" | "m" | "h" | "d" }
 * ```
 *
 * Typing the window as a value rather than as free text is what makes
 * "a `formerly` without a window" unrepresentable in the builders (#1658's
 * third lint wall) — you cannot call {@link formerly} without one.
 *
 * The `param_ref` arm (`within ?w`) is legal only inside a macro body; it is
 * modelled by {@link MacroWindow} rather than by this type, so an ordinary
 * policy cannot accidentally emit a sigil the expander would reject.
 */

/** The four units upstream's grammar admits. Anything else does not parse. */
export type TimeUnit = "s" | "m" | "h" | "d";

/** A `within` payload: a positive integer and one of the four units. */
export interface TemporalWindow {
  readonly value: number;
  readonly unit: TimeUnit;
}

/**
 * A window as written in a `.dw` file (`"1h"`, `"30m"`, `"7d"`).
 *
 * The template-literal arm means `formerly("1h", …)` type-checks and
 * `formerly("1w", …)` does not, without anyone writing a runtime check first.
 */
export type WindowLike = TemporalWindow | `${number}${TimeUnit}`;

/**
 * `within ?w` — a window a macro takes as a parameter.
 *
 * The other arm of upstream's `within_payload`. Legal only inside a macro
 * body; the expander resolves it against the call site's bare interval
 * argument (`once(1h, …)`), which is why the call side has no `within`.
 */
export interface WindowParam {
  readonly param: string;
}

/** Either a concrete window or a macro parameter standing in for one. */
export type WindowValue = TemporalWindow | WindowParam;

const WINDOW_TEXT = /^(\d+)([smhd])$/;
const PARAM_TEXT = /^\?[A-Za-z_][A-Za-z0-9_]*$/;

/** True when the payload is `?w` rather than `1h`. */
export function isWindowParam(value: WindowValue): value is WindowParam {
  return "param" in value;
}

/**
 * `within ?w` inside a macro body.
 *
 * Exported from `./macros.ts` too, which is where the sigil rules are
 * documented and where a reader looking for it will be.
 */
export function windowParam(param: string): WindowParam {
  if (!PARAM_TEXT.test(param)) {
    throw new Error(`dogwood: a window parameter carries the "?" sigil — got "${param}"`);
  }
  return { param };
}

/** Seconds in one of each unit — the scale `max_window` comparisons run on. */
const UNIT_SECONDS: Record<TimeUnit, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** Narrow a {@link WindowLike} to the structured form, validating as it goes. */
export function window(value: WindowLike): TemporalWindow {
  if (typeof value !== "string") {
    if (!Number.isInteger(value.value) || value.value < 0) {
      throw new Error(`dogwood: a temporal window must be a non-negative integer, got ${String(value.value)}`);
    }
    if (!(value.unit in UNIT_SECONDS)) {
      throw new Error(`dogwood: a temporal window unit must be s, m, h or d, got "${String(value.unit)}"`);
    }
    return { value: value.value, unit: value.unit };
  }

  const match = WINDOW_TEXT.exec(value);
  if (!match) {
    throw new Error(`dogwood: "${value}" is not a temporal window — write an integer and one of s, m, h, d (for example "1h")`);
  }
  return { value: Number(match[1]), unit: match[2] as TimeUnit };
}

/** `1h` — the surface form, in a `within` clause or as a macro-call argument. */
export function renderWindow(value: WindowLike): string {
  const w = window(value);
  return `${w.value}${w.unit}`;
}

/** A `within` payload: `1h`, or the `?w` a macro body defers to its call site. */
export function renderWindowValue(value: WindowValue): string {
  return isWindowParam(value) ? value.param : renderWindow(value);
}

/** Narrow a window argument, letting a `?w` parameter through unchanged. */
export function windowValue(value: WindowLike | WindowParam): WindowValue {
  return typeof value === "object" && "param" in value ? windowParam(value.param) : window(value);
}

/** The window in seconds, so `90m` and `1h` are comparable to a `max_window`. */
export function windowSeconds(value: WindowLike): number {
  const w = window(value);
  return w.value * UNIT_SECONDS[w.unit];
}

/**
 * Upstream's fallback cap. `ServiceSchema::defaults()` and an event schema
 * with no `max_window` directive both look back at most 24 hours, per the
 * comment atop `event_schema/grammar.pest` ("absent → a 24h default").
 */
export const DEFAULT_MAX_WINDOW: TemporalWindow = { value: 24, unit: "h" };
