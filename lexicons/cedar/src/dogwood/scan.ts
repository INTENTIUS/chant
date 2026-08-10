/**
 * Reading the emitted dogwood artifacts back, for the DWD post-synth checks.
 *
 * The checks judge the *text*, not the in-memory model, for the same reason
 * the CED checks judge `policies.cedar.json`: `chant audit` runs over a
 * checked-in artifact chant did not write, and a wall that only fires on
 * chant's own output is not a wall. It also means the typed builders and the
 * walls are independent — DWDC012 catches a windowless `formerly` even though
 * the builders cannot construct one, because `raw()` and a hand-written `.dw`
 * both can.
 *
 * This is scanning, not parsing. Upstream owns the parser and #1659 owns
 * shelling to it; what is here is the subset of the surface that answers the
 * three questions the walls ask, plus enough comment handling not to be fooled
 * by a commented-out clause.
 */

import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { DEFAULT_MAX_WINDOW, windowSeconds, type TimeUnit } from "./window";
import { DOGWOOD_EVENT_SCHEMA_SUFFIX, DOGWOOD_POLICY_SUFFIX } from "./serialize";

/** One emitted artifact, with everything needed to name it in a finding. */
export interface DogwoodArtifact {
  /** The lexicon output it came from. */
  lexicon: string;
  /** The filename, which is what a finding points the reader at. */
  source: string;
  /** The file's text. */
  text: string;
}

/** Every `.dw` policy file in the build output. */
export function dogwoodPolicyFiles(ctx: PostSynthContext): DogwoodArtifact[] {
  return filesWithSuffix(ctx, DOGWOOD_POLICY_SUFFIX);
}

/** Every `.dwschema` event-schema file in the build output. */
export function dogwoodSchemaFiles(ctx: PostSynthContext): DogwoodArtifact[] {
  return filesWithSuffix(ctx, DOGWOOD_EVENT_SCHEMA_SUFFIX);
}

function filesWithSuffix(ctx: PostSynthContext, suffix: string): DogwoodArtifact[] {
  const found: DogwoodArtifact[] = [];
  for (const [lexicon, output] of ctx.outputs) {
    if (typeof output === "string") continue;
    for (const [filename, content] of Object.entries(output.files ?? {})) {
      if (typeof content !== "string") continue;
      if (!filename.endsWith(suffix)) continue;
      found.push({ lexicon, source: filename, text: content });
    }
  }
  return found;
}

// ── Comments ──────────────────────────────────────────────────────

/**
 * Blank out `//` comments, leaving string literals intact.
 *
 * String literals stay because a predicate's action id lives inside one
 * (`Drupe::Action::"Read"`), and blanking those would blind every scan below.
 * The walk is string-aware in the other direction too: a `//` inside a quoted
 * value (a URL, say) is not a comment.
 *
 * Comment bytes become spaces so every offset in the result still lines up
 * with the original file.
 */
export function blankComments(text: string): string {
  const out = text.split("");
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        out[i] = " ";
        i++;
      }
    }
  }
  return out.join("");
}

// ── Temporal regions ──────────────────────────────────────────────

/**
 * The stretches of a `.dw` file that the temporal sub-parser reads: every
 * `temporal { … }` marker body, and every `def temporal … { … }` macro body.
 *
 * Scanning only these is what keeps a Cedar `when { … }` clause from being
 * mistaken for temporal source — `context.retryWindow == 3` should not read as
 * a window, and a Cedar attribute named `since` is not the `since` operator.
 */
export function temporalRegions(text: string): string[] {
  const source = blankComments(text);
  const regions: string[] = [];

  const markers = /\btemporal\s*\{/g;
  for (let m = markers.exec(source); m !== null; m = markers.exec(source)) {
    const body = matchedBlock(source, m.index + m[0].length - 1);
    if (body !== undefined) regions.push(body);
  }

  const macros = /\bdef\s+temporal\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)\s*\{/g;
  for (let m = macros.exec(source); m !== null; m = macros.exec(source)) {
    const body = matchedBlock(source, m.index + m[0].length - 1);
    if (body !== undefined) regions.push(body);
  }

  return regions;
}

/** The text between `text[open]` (a `{`) and its matching `}`, or undefined. */
function matchedBlock(text: string, open: number): string | undefined {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return undefined;
}

// ── What the walls ask ────────────────────────────────────────────

/** One `Ns::Action::"Name"::kind` predicate head found in temporal source. */
export interface TemporalPredicateRef {
  /** The qualified action, quoted id and all. */
  action: string;
  /** The event kind segment after the quoted id. */
  kind: string;
}

const PREDICATE = /([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*::"[^"]*")::([A-Za-z_][A-Za-z0-9_]*)/g;

/** Every temporal predicate head in a `.dw` file, in source order. */
export function scanPredicates(text: string): TemporalPredicateRef[] {
  const refs: TemporalPredicateRef[] = [];
  for (const region of temporalRegions(text)) {
    for (let m = PREDICATE.exec(region); m !== null; m = PREDICATE.exec(region)) {
      refs.push({ action: m[1], kind: m[2] });
    }
    PREDICATE.lastIndex = 0;
  }
  return refs;
}

/** One window literal found in temporal source. */
export interface WindowRef {
  /** As written: `48h`. */
  text: string;
  seconds: number;
  /** `within` for an operator's window, `argument` for a bare macro-call interval. */
  position: "within" | "argument";
}

const WITHIN_WINDOW = /\bwithin\s+(\d+)([smhd])\b/g;
/** A bare interval in macro-call argument position: `once(1h, …)`, `f(a, 30m)`. */
const ARGUMENT_WINDOW = /[(,]\s*(\d+)([smhd])\s*(?=[,)])/g;

/**
 * Every window literal in a `.dw` file's temporal source.
 *
 * Both shapes count against `max_window`: a macro-call interval is the window
 * a `within ?w` in the macro body resolves to, so `once(48h, …)` looks back
 * exactly as far as `formerly within 48h` does.
 */
export function scanWindows(text: string): WindowRef[] {
  const windows: WindowRef[] = [];
  for (const region of temporalRegions(text)) {
    for (let m = WITHIN_WINDOW.exec(region); m !== null; m = WITHIN_WINDOW.exec(region)) {
      windows.push(windowRef(m[1], m[2], "within"));
    }
    WITHIN_WINDOW.lastIndex = 0;
    for (let m = ARGUMENT_WINDOW.exec(region); m !== null; m = ARGUMENT_WINDOW.exec(region)) {
      windows.push(windowRef(m[1], m[2], "argument"));
    }
    ARGUMENT_WINDOW.lastIndex = 0;
  }
  return windows;
}

function windowRef(value: string, unit: string, position: WindowRef["position"]): WindowRef {
  const w = { value: Number(value), unit: unit as TimeUnit };
  return { text: `${w.value}${w.unit}`, seconds: windowSeconds(w), position };
}

/**
 * Every `formerly` / `previous` / `since` that is not followed by a `within`.
 *
 * Unrepresentable through the builders — {@link formerly} and its siblings all
 * take the window as an argument — but reachable through `raw()`, through a
 * hand-written `.dw`, and through an audit of a file chant never wrote.
 */
export function scanWindowlessOperators(text: string): string[] {
  const found: string[] = [];
  const pattern = /\b(formerly|previous|since)\b(?!\s+within\b)/g;
  for (const region of temporalRegions(text)) {
    for (let m = pattern.exec(region); m !== null; m = pattern.exec(region)) {
      found.push(m[1]);
    }
    pattern.lastIndex = 0;
  }
  return found;
}

// ── The event schema side ─────────────────────────────────────────

/** What a `.dwschema` file says, as far as the walls need to know. */
export interface EventSchemaFacts {
  /** Every declared event kind. */
  kinds: string[];
  /** The `max_window` directive in seconds, or upstream's 24h default when absent. */
  maxWindowSeconds: number;
  /** As written (`30d`), or undefined when the directive is absent. */
  maxWindowText?: string;
  /** True when at least one field carries a `pin … = …`. */
  hasPin: boolean;
}

const EVENT_DECL = /\bevent\s*<\s*[A-Za-z_][A-Za-z0-9_]*\s*>\s*::\s*([A-Za-z_][A-Za-z0-9_]*)/g;
const MAX_WINDOW = /\bmax_window\s*=\s*(\d+)([smhd])\b/;
const PINNED_FIELD = /\bpin\s+[A-Za-z_][A-Za-z0-9_]*\s*:/;

/** Read a `.dwschema` file's declarations. */
export function readEventSchema(text: string): EventSchemaFacts {
  const source = blankComments(text);

  const kinds: string[] = [];
  for (let m = EVENT_DECL.exec(source); m !== null; m = EVENT_DECL.exec(source)) {
    if (!kinds.includes(m[1])) kinds.push(m[1]);
  }
  EVENT_DECL.lastIndex = 0;

  const max = MAX_WINDOW.exec(source);
  return {
    kinds,
    maxWindowSeconds: max
      ? windowSeconds({ value: Number(max[1]), unit: max[2] as TimeUnit })
      : windowSeconds(DEFAULT_MAX_WINDOW),
    maxWindowText: max ? `${max[1]}${max[2]}` : undefined,
    hasPin: PINNED_FIELD.test(source),
  };
}

/**
 * The look-back cap in force for a build.
 *
 * With no emitted schema, `ServiceSchema::defaults()` applies and the cap is
 * 24h. With several, the tightest one wins — a window legal under one schema
 * and not another is a window some consumer will reject.
 */
export function effectiveMaxWindowSeconds(schemas: EventSchemaFacts[]): { seconds: number; text: string } {
  if (schemas.length === 0) {
    return {
      seconds: windowSeconds(DEFAULT_MAX_WINDOW),
      text: `${DEFAULT_MAX_WINDOW.value}${DEFAULT_MAX_WINDOW.unit}`,
    };
  }
  let tightest = schemas[0];
  for (const s of schemas) if (s.maxWindowSeconds < tightest.maxWindowSeconds) tightest = s;
  return {
    seconds: tightest.maxWindowSeconds,
    text: tightest.maxWindowText ?? `${DEFAULT_MAX_WINDOW.value}${DEFAULT_MAX_WINDOW.unit}`,
  };
}
