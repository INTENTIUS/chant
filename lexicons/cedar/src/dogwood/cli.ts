/**
 * The `dogwood` CLI adapter (#1659, epic #1646).
 *
 * The epic splits validation by what needs a binary. Everything answerable in
 * TypeScript — the DWDC walls in `../lint/post-synth/dwdc0*.ts` — runs always
 * and gates. Full `.dw` validation needs upstream's own frontend, which ships
 * only as a Rust CLI: no npm package, no wasm build, nothing to link against.
 * This module is the seam to it, and everything downstream of it treats the
 * binary as optional.
 *
 * Five things about that CLI decide how this is written, all from the #1657
 * verification report and re-read from the pinned `dogwood-cli/src` sources:
 *
 * 1. **Exit codes do not identify the failure.** Exit 2 is both "the policy
 *    set was rejected" and clap's own usage error for an unknown flag, and the
 *    published guide claims 1 for the latter. So nothing here branches on the
 *    exit code: the JSON on stdout decides, and a run that produced no JSON is
 *    {@link DogwoodUnusable} — reported as "the CLI could not be used", never
 *    as "your policy is bad".
 * 2. **There are two JSON shapes, not one.** A type-check finding comes back
 *    in a `ValidateReport` (`{passed, passed_without_warnings, errors[],
 *    warnings[]}`); a fatal parse, macro or lowering error replaces the whole
 *    report with a bare `OpError` — the same diagnostic fields flattened at the
 *    top level, plus `related[]`. {@link parseValidateOutput} handles both.
 * 3. **`--format json` writes to stdout for both channels**, success and
 *    fatal alike, and human-mode errors go to stderr. Every call here passes
 *    `--format json` and reads stdout; stderr is kept only to explain an
 *    unusable run.
 * 4. **`--emit` is ignored under `--format json`** — the JSON always carries
 *    all three lowered artifacts — so {@link runDogwoodLower} does not pass it.
 * 5. **Label offsets are bytes into the source**, not line/column. They are
 *    rendered as byte ranges. The fatal channel's own internal positions are
 *    never passed through verbatim, for the same reason `wasm-helpers.ts`
 *    strips cedar-wasm's `at line 1 column 42`: they locate something in a
 *    representation the reader never saw.
 *
 * The runner is injectable ({@link configureDogwoodCli}) so the checks are
 * testable without the binary. Nothing in gating CI executes it.
 */

import { spawnSync } from "child_process";
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, dirname, isAbsolute, join, resolve } from "path";

// ── Locating the binary ───────────────────────────────────────────

/** The executable name looked up on `PATH`. */
export const DOGWOOD_BINARY_NAME = "dogwood";

/** Environment override, read before `PATH` and after an explicit config. */
export const DOGWOOD_BINARY_ENV = "CHANT_DOGWOOD_BINARY";

/** Where a resolved binary came from — carried so a finding can say. */
export type DogwoodBinarySource = "override" | "env" | "config" | "path";

/** A located `dogwood` executable. */
export interface DogwoodBinary {
  /** Absolute path, or the configured path as written. */
  path: string;
  source: DogwoodBinarySource;
}

/**
 * One process run, reduced to what the adapter reads.
 *
 * `error` is set when the process never ran at all (ENOENT, a permission
 * failure, a timeout) — distinct from a run that exited non-zero.
 */
export interface DogwoodRun {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Runs `binary args…` and returns the captured streams. Injectable for tests. */
export type DogwoodRunner = (binary: string, args: string[]) => DogwoodRun;

interface CliDefaults {
  /** A path forces that binary; `null` forces "absent"; `undefined` resolves normally. */
  binary?: string | null;
  runner?: DogwoodRunner;
}

let defaults: CliDefaults = {};

/**
 * Override binary resolution and the process runner.
 *
 * Two callers. Tests inject a runner so no gating check ever depends on a real
 * binary — including on a developer's machine that happens to have one, which
 * is why `binary: null` (force-absent) exists as well as `binary: "/path"`.
 * The on-demand harness — the `forgejo-runtime-e2e` shape the epic names — is
 * the other: it knows where it built the binary and says so directly rather
 * than arranging `PATH`.
 */
export function configureDogwoodCli(options: CliDefaults): void {
  defaults = { ...defaults, ...options };
}

/** Drop every override, including any cached resolution. Test-only. */
export function resetDogwoodCli(): void {
  defaults = {};
  cachedConfigBinary = undefined;
}

let cachedConfigBinary: { dir: string; value: string | undefined } | undefined;

/**
 * `cedar.dogwood.binary` out of a `chant.config.json`, walking up from `dir`.
 *
 * JSON only, and that is a real limitation rather than an oversight. A
 * `PostSynthCheck.check()` is synchronous — see `@intentius/chant/lint/post-synth`
 * — while `loadChantConfigUpward` is async and, under `chant build --sandbox`,
 * evaluates `chant.config.ts` in a child process. Neither is available from
 * inside a check. `chant.config.json` is data, not code (core says so in
 * `loadChantConfig`'s own doc), so reading it here executes nothing. A project
 * on `chant.config.ts` sets {@link DOGWOOD_BINARY_ENV} or calls
 * {@link configureDogwoodCli} instead.
 */
function configuredBinary(startDir: string): string | undefined {
  if (cachedConfigBinary && cachedConfigBinary.dir === startDir) return cachedConfigBinary.value;

  let value: string | undefined;
  let dir = startDir;
  for (;;) {
    const path = join(dir, "chant.config.json");
    if (existsSync(path)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
        const binary = readPath(parsed, ["cedar", "dogwood", "binary"]);
        if (typeof binary === "string" && binary.length > 0) {
          value = isAbsolute(binary) ? binary : resolve(dir, binary);
          break;
        }
      } catch {
        // An unreadable or malformed config is every other command's error to
        // report first; a missing dogwood binary is not the place to raise it.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  cachedConfigBinary = { dir: startDir, value };
  return value;
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first `dogwood` on `PATH`, by an access check rather than by running it. */
function onPath(name: string): string | undefined {
  for (const entry of (process.env.PATH ?? "").split(delimiter)) {
    if (!entry) continue;
    const candidate = join(entry, name);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Locate the `dogwood` binary, or `undefined` when there is none.
 *
 * Order: an explicit {@link configureDogwoodCli} override, `$CHANT_DOGWOOD_BINARY`,
 * `cedar.dogwood.binary` from a `chant.config.json`, then `PATH`. A path from
 * the environment or the config that is not executable is resolved past rather
 * than returned to fail later; the advisory that follows names where chant
 * looked. An explicit override is taken as given — its caller knows.
 */
export function findDogwoodBinary(cwd: string = process.cwd()): DogwoodBinary | undefined {
  if (defaults.binary === null) return undefined;
  if (typeof defaults.binary === "string") return { path: defaults.binary, source: "override" };

  const fromEnv = process.env[DOGWOOD_BINARY_ENV];
  if (fromEnv && executable(fromEnv)) return { path: fromEnv, source: "env" };

  const fromConfig = configuredBinary(cwd);
  if (fromConfig && executable(fromConfig)) return { path: fromConfig, source: "config" };

  const found = onPath(DOGWOOD_BINARY_NAME);
  return found ? { path: found, source: "path" } : undefined;
}

/** Where chant looked, for an advisory that has to be actionable. */
export const DOGWOOD_SEARCH_ORDER = `$${DOGWOOD_BINARY_ENV}, then cedar.dogwood.binary in chant.config.json, then \`${DOGWOOD_BINARY_NAME}\` on PATH`;

// ── The JSON contract ─────────────────────────────────────────────

/** One labelled span: byte offsets into the source the CLI was handed. */
export interface DogwoodLabel {
  start: number;
  len: number;
  message?: string;
}

/**
 * One diagnostic, in upstream's `Diagnostic` shape.
 *
 * The same object is the element type of a report's `errors[]`/`warnings[]`
 * and the whole body of a fatal `OpError`, which is why both channels
 * normalize into this and nothing downstream has to know which arrived.
 */
export interface DogwoodDiagnostic {
  /** `error`, `warning` or `advice` — upstream lowercases miette's severity. */
  severity: string;
  /** A stable code such as `extension` or `cedar`, when the finding has one. */
  code?: string;
  message: string;
  labels: DogwoodLabel[];
  help?: string;
  /** False when the finding has no source-anchored span at all. */
  spanned: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strip an internal `at line N column M` tail.
 *
 * Same reasoning as `wasm-helpers.ts`'s `call()`: a position that indexes a
 * representation the reader never saw is worse than no position, because it
 * looks like it points at their policy. The byte-offset labels are the
 * positions this module does surface, and those genuinely index the `.dw`
 * source chant wrote.
 */
function scrubPosition(message: string): string {
  return message.replace(/\s+at line \d+ column \d+\.?$/, "");
}

function parseDiagnostic(value: unknown): DogwoodDiagnostic | undefined {
  if (!isRecord(value) || typeof value.message !== "string") return undefined;
  const labels: DogwoodLabel[] = [];
  if (Array.isArray(value.labels)) {
    for (const raw of value.labels) {
      if (!isRecord(raw) || typeof raw.start !== "number" || typeof raw.len !== "number") continue;
      labels.push({
        start: raw.start,
        len: raw.len,
        ...(typeof raw.message === "string" ? { message: raw.message } : {}),
      });
    }
  }
  return {
    severity: typeof value.severity === "string" ? value.severity : "error",
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    message: scrubPosition(value.message),
    labels,
    ...(typeof value.help === "string" ? { help: value.help } : {}),
    spanned: value.spanned === true || labels.length > 0,
  };
}

function parseDiagnostics(value: unknown): DogwoodDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const out: DogwoodDiagnostic[] = [];
  for (const entry of value) {
    const parsed = parseDiagnostic(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * One diagnostic as a single line: code, message, help, then the byte ranges.
 *
 * Byte offsets rather than line/column because that is what upstream reports
 * and converting them would mean re-deriving line breaks over a file this
 * module does not hold — a wrong line number is worse than an honest offset.
 */
export function formatDogwoodDiagnostic(diagnostic: DogwoodDiagnostic): string {
  const parts: string[] = [];
  if (diagnostic.code) parts.push(`[${diagnostic.code}]`);
  parts.push(diagnostic.message);
  if (diagnostic.help) parts.push(`(${diagnostic.help})`);
  if (diagnostic.labels.length > 0) {
    const spans = diagnostic.labels
      .map((l) => {
        const range = `bytes ${l.start}-${l.start + l.len}`;
        return l.message ? `${range}: ${l.message}` : range;
      })
      .join("; ");
    parts.push(`at ${spans}`);
  }
  return parts.join(" ");
}

// ── Results ───────────────────────────────────────────────────────

/**
 * The CLI could not be used — a spawn failure, output that is not the JSON
 * this adapter knows, or the exit-2 ambiguity resolving to neither shape.
 *
 * Deliberately its own arm and never folded into "rejected": exit 2 covers an
 * unknown flag as well as a rejected policy set, so treating a bare non-zero
 * exit as a policy verdict would fail a build over a flag rename in a sync
 * upstream can make without notice.
 */
export interface DogwoodUnusable {
  kind: "unusable";
  reason: string;
}

/** A fatal parse, macro or lowering error — upstream's `OpError` channel. */
export interface DogwoodFatal {
  kind: "fatal";
  error: DogwoodDiagnostic;
  related: DogwoodDiagnostic[];
}

export type DogwoodValidateResult =
  | { kind: "passed"; warnings: DogwoodDiagnostic[] }
  | { kind: "rejected"; errors: DogwoodDiagnostic[]; warnings: DogwoodDiagnostic[] }
  | DogwoodFatal
  | DogwoodUnusable;

/** The `lower` artifacts. `cedarSchemaJson` is a JSON *string*, as upstream serializes it. */
export interface DogwoodLowered {
  cedarPolicies: string;
  cedarSchema: string;
  cedarSchemaJson: string;
  /** False when temporal or provider fields were hoisted — the usual case. */
  selfContained: boolean;
  temporalFields: string[];
  providerFields: string[];
  decisionKinds: string[];
}

export type DogwoodLowerResult = { kind: "lowered"; value: DogwoodLowered } | DogwoodFatal | DogwoodUnusable;

function unusable(reason: string): DogwoodUnusable {
  return { kind: "unusable", reason };
}

/** A short, single-line tail of whatever the process said, for an unusable run. */
function streamNote(run: DogwoodRun): string {
  const text = (run.stderr || run.stdout).trim().split("\n").slice(0, 2).join(" ").trim();
  const clipped = text.length > 200 ? `${text.slice(0, 200)}…` : text;
  return clipped ? `: ${clipped}` : "";
}

function fatalFrom(parsed: Record<string, unknown>): DogwoodFatal | undefined {
  const error = parseDiagnostic(parsed);
  if (!error) return undefined;
  return { kind: "fatal", error, related: parseDiagnostics(parsed.related) };
}

/**
 * Read a `validate --format json` run.
 *
 * The JSON decides, not the exit code. A body carrying `passed` is the report
 * shape; a body carrying `message` and no `passed` is the fatal `OpError`
 * shape; anything else means the invocation itself was rejected — which is
 * where clap's exit-2 usage error lands, with its complaint on stderr and
 * nothing on stdout.
 */
export function parseValidateOutput(run: DogwoodRun): DogwoodValidateResult {
  if (run.error) return unusable(`the dogwood binary could not be run: ${run.error}`);

  const parsed = readJson(run.stdout);
  if (!parsed) {
    return unusable(
      `\`dogwood validate --format json\` exited ${String(run.status)} without a JSON report on stdout, which is how an unknown flag or a rejected invocation surfaces${streamNote(run)}`,
    );
  }

  if (typeof parsed.passed === "boolean") {
    const errors = parseDiagnostics(parsed.errors);
    const warnings = parseDiagnostics(parsed.warnings);
    // The report wins over the exit code in both directions: a `passed: false`
    // with a zero exit is still a rejection, and the reverse is still a pass.
    if (parsed.passed && errors.length === 0) return { kind: "passed", warnings };
    return { kind: "rejected", errors, warnings };
  }

  const fatal = fatalFrom(parsed);
  if (fatal) return fatal;

  return unusable(`\`dogwood validate --format json\` returned JSON in neither the report nor the error shape`);
}

/** Read a `lower --format json` run. Same two-shape discipline as validate. */
export function parseLowerOutput(run: DogwoodRun): DogwoodLowerResult {
  if (run.error) return unusable(`the dogwood binary could not be run: ${run.error}`);

  const parsed = readJson(run.stdout);
  if (!parsed) {
    return unusable(
      `\`dogwood lower --format json\` exited ${String(run.status)} without JSON on stdout${streamNote(run)}`,
    );
  }

  if (typeof parsed.cedar_policies === "string" && typeof parsed.cedar_schema === "string") {
    return {
      kind: "lowered",
      value: {
        cedarPolicies: parsed.cedar_policies,
        cedarSchema: parsed.cedar_schema,
        cedarSchemaJson: typeof parsed.cedar_schema_json === "string" ? parsed.cedar_schema_json : "",
        selfContained: parsed.self_contained === true,
        temporalFields: stringList(parsed.temporal_fields),
        providerFields: stringList(parsed.provider_fields),
        decisionKinds: stringList(parsed.decision_kinds),
      },
    };
  }

  const fatal = fatalFrom(parsed);
  if (fatal) return fatal;

  return unusable("`dogwood lower --format json` returned JSON in neither the artifact nor the error shape");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function readJson(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// ── Invocation ────────────────────────────────────────────────────

/**
 * The files one CLI invocation needs.
 *
 * `policies` and `policySchema` are both required — every pipeline command
 * takes the policy set positionally and `--policy-schema` is not optional. The
 * rest are the service half of the schema, each defaulting at the far end.
 */
export interface DogwoodBundle {
  /** `.dw` policy set text. */
  policies: string;
  /** Cedar action schema text (`--policy-schema`). */
  policySchema: string;
  /** `.dwschema` event-schema text (`--event-schema`). */
  eventSchema?: string;
  /** `.dw` macro library text (`--macros`). */
  macros?: string;
  /** `providers.json` text (`--providers`). Rhai must be inlined under `implementation.script`. */
  providers?: string;
}

const defaultRunner: DogwoodRunner = (binary, args) => {
  const result = spawnSync(binary, args, {
    encoding: "utf-8",
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error.message } : {}),
  };
};

/**
 * Materialize a bundle into a scratch directory and run one subcommand.
 *
 * Files rather than stdin because only the policy set can come from `-`; the
 * schema flags all take paths. The directory is removed in a `finally`, so a
 * throwing runner does not leave one behind.
 */
function runBundle(binary: string, subcommand: string, bundle: DogwoodBundle): DogwoodRun {
  const runner = defaults.runner ?? defaultRunner;
  const dir = mkdtempSync(join(tmpdir(), "chant-dogwood-"));
  try {
    const policies = join(dir, "policies.dw");
    const policySchema = join(dir, "schema.cedarschema");
    writeFileSync(policies, bundle.policies, "utf-8");
    writeFileSync(policySchema, bundle.policySchema, "utf-8");

    const args = [subcommand, policies, "--policy-schema", policySchema];

    if (bundle.eventSchema !== undefined) {
      const path = join(dir, "events.dwschema");
      writeFileSync(path, bundle.eventSchema, "utf-8");
      args.push("--event-schema", path);
    }
    if (bundle.macros !== undefined) {
      const path = join(dir, "macros.dw");
      writeFileSync(path, bundle.macros, "utf-8");
      args.push("--macros", path);
    }
    if (bundle.providers !== undefined) {
      const path = join(dir, "providers.json");
      writeFileSync(path, bundle.providers, "utf-8");
      args.push("--providers", path);
    }

    // No `--emit`: it is ignored under `--format json`, which returns all three
    // lowered artifacts regardless. Passing it would imply a choice that the
    // CLI does not honour.
    args.push("--format", "json");

    return runner(binary, args);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run `dogwood validate` over a bundle. Never throws. */
export function runDogwoodValidate(binary: string, bundle: DogwoodBundle): DogwoodValidateResult {
  try {
    return parseValidateOutput(runBundle(binary, "validate", bundle));
  } catch (err) {
    return unusable(`the dogwood validate run failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Run `dogwood lower` over a bundle. Never throws. */
export function runDogwoodLower(binary: string, bundle: DogwoodBundle): DogwoodLowerResult {
  try {
    return parseLowerOutput(runBundle(binary, "lower", bundle));
  } catch (err) {
    return unusable(`the dogwood lower run failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
