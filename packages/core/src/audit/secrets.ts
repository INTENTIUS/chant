/**
 * Secrets & credential detection (#443) — a finding family that is
 * independent of lexicon. Every other finding family in this directory reads
 * a specific CI dialect's structure (a GitHub Actions `steps:` array, a
 * GitLab `variables:` block); this one scans the raw text of any file the
 * audit already reads for shapes that look like a live credential, no matter
 * what kind of file it lives in.
 *
 * Three layers, cheapest/highest-precision first:
 *  1. Well-known provider prefixes (AWS `AKIA…`, GitHub `ghp_…`, Slack
 *     `xox…`, Google `AIza…`, Stripe `sk_live_…`) — near-zero false-positive
 *     rate because the shape is a vendor-documented constant.
 *  2. Structural shapes (a PEM private-key block, a `scheme://user:pass@host`
 *     connection string) — still high precision.
 *  3. A generic high-entropy-string heuristic as the catch-all for anything
 *     that doesn't match a known shape. This is the noisy layer, so it only
 *     fires on tokens with real character-class diversity, skips pure-hex
 *     runs (git SHAs, checksums), and defaults to a conservative threshold
 *     that callers can tune.
 *
 * Pure: no fs, no network, no Node-only global. Safe to run in the Workers
 * runtime the hosted audit service uses (epic #350's edge constraint) as well
 * as the CLI.
 *
 * Redaction is the load-bearing guarantee here, not an afterthought: nothing
 * this module returns — message, entity, or any other field on the
 * `AuditFinding` — ever contains the matched secret text. Callers get the
 * rule id, a human label for the kind of secret, the file/line location, and
 * a non-reversible fingerprint of the value (for the allowlist below) —
 * never the value itself. See `secrets.test.ts`'s redaction-guarantee test.
 */

import type { AuditFinding } from "./core";
import type { Severity } from "../lint/rule";

/** The minimal file shape the scanner needs (matches `discover.ts`'s `RepoFile`). */
export interface ScannableFile {
  path: string;
  content: string;
}

/**
 * One allowlist entry. At least one of `ruleId` / `fingerprint` must be set —
 * `file` alone is not enough to allow everything in a file, so a stray file
 * entry can't silently blanket-suppress a real secret added later.
 * `fingerprint` is `fingerprintSecret(value)` of the *redacted* value, so an
 * allowlist entry never has to contain the secret itself.
 */
export interface SecretAllowRule {
  /** Restrict this allow entry to one rule id (e.g. "SEC010"). */
  ruleId?: string;
  /** Restrict to one file — exact relative path, or a path-suffix match. */
  file?: string;
  /** `fingerprintSecret(value)` of the specific occurrence to allow. */
  fingerprint?: string;
}

export interface SecretsScanOptions {
  /** Shannon-entropy threshold (bits/char) above which a token is flagged. Default 4.0 — tunable (#443). */
  entropyThreshold?: number;
  /** Minimum candidate-token length the entropy heuristic considers. Default 24. */
  entropyMinLength?: number;
  /** Ignore/allow entries (#443) — suppress specific findings without an inline marker. */
  allow?: SecretAllowRule[];
}

const DEFAULT_ENTROPY_THRESHOLD = 4.0;
const DEFAULT_ENTROPY_MIN_LENGTH = 24;

// ── Redaction-safe fingerprinting ───────────────────────────────────────

/**
 * A short fingerprint of a secret value (two intertwined 32-bit hash
 * accumulators, 16 hex chars). Lets an allowlist entry — or a report —
 * reference "this exact occurrence" without ever storing or displaying the
 * secret itself. Not a cryptographic digest (no `crypto` dependency, so this
 * stays pure/edge-safe); it only needs to key an allowlist entry, not resist
 * a determined attacker who already suspects the plaintext.
 */
export function fingerprintSecret(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c;
    h2 = Math.imul(h2, 0x85ebca6b);
    h2 = (h2 << 13) | (h2 >>> 19);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

// ── Inline ignore marker ────────────────────────────────────────────────

/**
 * Inline suppression marker: a comment containing `chant-audit-ignore`,
 * optionally scoped to one or more rule ids (`chant-audit-ignore: SEC001`,
 * `chant-audit-ignore SEC001,SEC010`). Bare (no rule ids) suppresses every
 * secrets finding on the line. Works in any comment syntax (`#`, `//`, etc.)
 * since only the marker text is matched, not the comment delimiter.
 *
 * Checked against the finding's own line AND the line immediately above it —
 * a PEM block's `-----BEGIN…-----` line can't carry a trailing comment
 * without corrupting the key, so the marker goes on the line before it.
 */
const IGNORE_MARKER_RE = /chant-audit-ignore(?:[:=]?\s*([A-Za-z0-9,\s-]+))?/i;

function parseIgnoreMarker(line: string): { all: boolean; ids: Set<string> } | undefined {
  const m = line.match(IGNORE_MARKER_RE);
  if (!m) return undefined;
  const raw = m[1]?.trim();
  if (!raw) return { all: true, ids: new Set() };
  const ids = raw
    .split(/[,\s]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  return ids.length === 0 ? { all: true, ids: new Set() } : { all: false, ids: new Set(ids) };
}

function isIgnoredByMarker(lines: string[], lineIdx0: number, ruleId: string): boolean {
  for (const idx of [lineIdx0, lineIdx0 - 1]) {
    if (idx < 0 || idx >= lines.length) continue;
    const marker = parseIgnoreMarker(lines[idx]);
    if (marker && (marker.all || marker.ids.has(ruleId))) return true;
  }
  return false;
}

// ── Config allowlist ────────────────────────────────────────────────────

function isAllowed(allow: SecretAllowRule[], f: { ruleId: string; file: string; fingerprint: string }): boolean {
  return allow.some((a) => {
    if (!a.ruleId && !a.fingerprint) return false; // `file` alone never allows everything in a file
    if (a.ruleId && a.ruleId !== f.ruleId) return false;
    if (a.fingerprint && a.fingerprint !== f.fingerprint) return false;
    if (a.file && a.file !== f.file && !f.file.endsWith(`/${a.file}`)) return false;
    return true;
  });
}

/**
 * Parse a `.chant-audit.json`-style config's `secrets` section (or a flat
 * object with the same shape) into scan options. Pure — a caller reads the
 * file (CLI: fs; hosted: an already-fetched file), this only parses the
 * text. Tolerant: malformed/missing content yields no options rather than
 * throwing.
 */
export function parseSecretsConfig(content: string): SecretsScanOptions {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return {};
  }
  const root = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const sec = root.secrets && typeof root.secrets === "object" ? (root.secrets as Record<string, unknown>) : root;

  const opts: SecretsScanOptions = {};
  if (typeof sec.entropyThreshold === "number") opts.entropyThreshold = sec.entropyThreshold;
  if (typeof sec.entropyMinLength === "number") opts.entropyMinLength = sec.entropyMinLength;
  if (Array.isArray(sec.allow)) {
    opts.allow = sec.allow
      .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
      .map((a) => ({
        ruleId: typeof a.ruleId === "string" ? a.ruleId : undefined,
        file: typeof a.file === "string" ? a.file : undefined,
        fingerprint: typeof a.fingerprint === "string" ? a.fingerprint : undefined,
      }));
  }
  return opts;
}

// ── Shannon entropy ─────────────────────────────────────────────────────

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ── Placeholder / low-signal exclusions ─────────────────────────────────

const PLACEHOLDER_RE = /example|placeholder|dummy|changeme|change-me|redacted|sample|fixme|todo|xxxxxxxx|your[-_]?(api[-_]?)?(key|token|secret)|fake[-_]?(key|token|secret)|test[-_]?(key|token|secret)/i;

/** Cheap, format-agnostic "this doesn't look like a real secret" filter. */
function looksLikePlaceholder(value: string): boolean {
  if (PLACEHOLDER_RE.test(value)) return true;
  const uniq = new Set(value.toLowerCase()).size;
  if (value.length > 8 && uniq <= 2) return true; // e.g. "0000000000000000"
  return false;
}

function connStringHasPlaceholderCreds(match: string): boolean {
  const m = match.match(/:\/\/([^:@/\s]+):([^@/\s]+)@/);
  if (!m) return false;
  const bland = /^(user(name)?|admin|root|pass(word)?|changeme|example|test|dummy|guest|secret)$/i;
  return bland.test(m[1]) && bland.test(m[2]);
}

// ── Pattern detectors ────────────────────────────────────────────────────

interface Detector {
  ruleId: string;
  kind: string;
  severity: Severity;
  regex: RegExp;
  /** The sensitive substring within the full match, for placeholder/fingerprint purposes. Defaults to the full match. */
  extract?: (m: RegExpMatchArray) => string;
  /** Extra placeholder/false-positive filter beyond the generic one. */
  extraFilter?: (fullMatch: string) => boolean;
}

const DETECTORS: Detector[] = [
  {
    ruleId: "SEC001",
    kind: "AWS access key ID",
    severity: "error",
    regex: /\b(?:AKIA|ABIA|ACCA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
  },
  {
    ruleId: "SEC002",
    kind: "AWS secret access key",
    severity: "error",
    regex: /\baws_secret_access_key\s*[:=]\s*['"]?([A-Za-z0-9/+]{40})['"]?/gi,
    extract: (m) => m[1],
  },
  {
    ruleId: "SEC003",
    kind: "GitHub token",
    severity: "error",
    regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
  },
  {
    ruleId: "SEC004",
    kind: "Slack token",
    severity: "error",
    regex: /\bxox[baprs]-[0-9A-Za-z-]{10,72}\b/g,
  },
  {
    ruleId: "SEC005",
    kind: "Google API key",
    severity: "error",
    regex: /\bAIza[0-9A-Za-z\-_]{35}\b/g,
  },
  {
    ruleId: "SEC006",
    kind: "Stripe live secret key",
    severity: "error",
    regex: /\b(?:sk|rk)_live_[0-9A-Za-z]{24,}\b/g,
  },
  {
    ruleId: "SEC007",
    kind: "PEM private key block",
    severity: "error",
    regex: /-----BEGIN ((?:RSA|EC|DSA|OPENSSH|ENCRYPTED|PGP) PRIVATE KEY|PRIVATE KEY)-----[\s\S]*?-----END \1-----/g,
  },
  {
    ruleId: "SEC008",
    kind: "Bearer/authorization token",
    severity: "warning",
    regex: /\b[Bb]earer\s+([A-Za-z0-9\-_.~+/]{20,}={0,2})/g,
    extract: (m) => m[1],
  },
  {
    ruleId: "SEC009",
    kind: "Credentials embedded in a connection string",
    severity: "error",
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|ftp|sftp|ldap|sqlserver|jdbc:[a-z]+):\/\/[^\s'"/:@]+:[^\s'"/@]+@[^\s'"/]+/gi,
    extraFilter: (full) => !connStringHasPlaceholderCreds(full),
  },
];

/** The high-entropy catch-all's rule id (kept distinct so callers can special-case it). */
export const ENTROPY_RULE_ID = "SEC010";

const HEX_ONLY_RE = /^[0-9a-f]+$/i;

/**
 * A `word-word-word`/`word/word` slug reads as a dashed/slashed identifier —
 * a model id (`anthropic/claude-sonnet-4-6`), an npm package spec, a docker
 * image ref — not a secret: a real random secret's `-`/`_`/`/` runs don't
 * line up with dictionary-shaped alphabetic chunks. Requires at least two
 * separators so a single hyphen (common inside genuine tokens) doesn't
 * trigger it.
 */
export function looksLikeIdentifierSlug(value: string): boolean {
  const parts = value.split(/[-_/]/).filter(Boolean);
  if (parts.length < 3) return false;
  const wordy = parts.filter((p) => /^[a-zA-Z]+$/.test(p) && p.length >= 3).length;
  return wordy / parts.length >= 0.5;
}

/** At least 3 of {lower, upper, digit, symbol} present — cuts plain-word / all-hex false positives. */
function hasClassDiversity(value: string): boolean {
  let classes = 0;
  if (/[a-z]/.test(value)) classes++;
  if (/[A-Z]/.test(value)) classes++;
  if (/[0-9]/.test(value)) classes++;
  if (/[^A-Za-z0-9]/.test(value)) classes++;
  return classes >= 3;
}

// ── Line-number lookup ───────────────────────────────────────────────────

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === "\n") starts.push(i + 1);
  return starts;
}

function lineNumberFor(starts: number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= index) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans + 1; // 1-based
}

// ── Scan ──────────────────────────────────────────────────────────────────

/**
 * Scan a set of files for likely secrets/credentials. Pure with respect to
 * the filesystem and network. Findings never carry the matched value —
 * only its rule id, kind, file/line, and a redaction-safe fingerprint.
 */
/**
 * Machine-generated dependency lockfiles. Skipped entirely: they are wall-to-
 * wall content-integrity hashes (`sha512-…` and friends), which the entropy
 * heuristic reads as hundreds of "possible secrets" per file — a single
 * `package-lock.json` produced 438 merge-worthy SEC010 findings on the first
 * repo that dogfooded this at `--fail-on merge-worthy`. Integrity hashes are
 * public by construction, a credential does not live in a lockfile, and no
 * other scanner reads them.
 */
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "deno.lock",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
  "flake.lock",
]);

/** Is this a dependency lockfile the secrets scan should skip? */
export function isLockfilePath(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return LOCKFILE_NAMES.has(name);
}

export function scanForSecrets(files: ScannableFile[], opts: SecretsScanOptions = {}): AuditFinding[] {
  const entropyThreshold = opts.entropyThreshold ?? DEFAULT_ENTROPY_THRESHOLD;
  const entropyMinLength = opts.entropyMinLength ?? DEFAULT_ENTROPY_MIN_LENGTH;
  const allow = opts.allow ?? [];
  const entropyRe = new RegExp(`[A-Za-z0-9_\\-+/=]{${entropyMinLength},}`, "g");

  const findings: AuditFinding[] = [];

  for (const file of files) {
    if (!file.content) continue;
    if (isLockfilePath(file.path)) continue;
    const lines = file.content.split("\n");
    const starts = lineStarts(file.content);
    const claimed: Array<[number, number]> = [];

    // `claimed` marks text a pattern detector already matched, so the entropy
    // catch-all doesn't re-flag the same value under SEC010 — regardless of
    // whether the pattern-detector's own finding gets suppressed below. An
    // ignored/allowed PEM block, for instance, must not have its base64 body
    // re-flagged as a fresh "high-entropy string" (that would defeat the
    // suppression, not just duplicate it).
    const emit = (ruleId: string, kind: string, severity: Severity, index: number, length: number, secretValue: string): void => {
      const lineNo = lineNumberFor(starts, index);
      if (isIgnoredByMarker(lines, lineNo - 1, ruleId)) return;
      const fingerprint = fingerprintSecret(secretValue);
      if (isAllowed(allow, { ruleId, file: file.path, fingerprint })) return;
      findings.push({
        checkId: ruleId,
        severity,
        message: `Likely secret detected: ${kind} at ${file.path}:${lineNo} (value redacted, ${secretValue.length} chars, fingerprint ${fingerprint}). Remove it from source and rotate the credential.`,
        file: file.path,
        lexicon: "secrets",
        entity: kind,
        line: lineNo,
        fingerprint,
      });
    };

    for (const d of DETECTORS) {
      for (const m of file.content.matchAll(d.regex)) {
        const full = m[0];
        const secretValue = d.extract ? d.extract(m) : full;
        if (!secretValue) continue;
        if (looksLikePlaceholder(secretValue)) continue;
        if (d.extraFilter && !d.extraFilter(full)) continue;
        const index = m.index ?? 0;
        claimed.push([index, index + full.length]);
        emit(d.ruleId, d.kind, d.severity, index, full.length, secretValue);
      }
    }

    for (const m of file.content.matchAll(entropyRe)) {
      const value = m[0];
      const start = m.index ?? 0;
      const end = start + value.length;
      if (claimed.some(([s, e]) => start < e && end > s)) continue; // already assessed by a pattern detector
      if (HEX_ONLY_RE.test(value)) continue; // likely a git SHA / checksum, not a secret
      if (!hasClassDiversity(value)) continue;
      if (looksLikePlaceholder(value)) continue;
      if (looksLikeIdentifierSlug(value)) continue; // a model id / package spec / image ref, not a secret
      const entropy = shannonEntropy(value);
      if (entropy < entropyThreshold) continue;
      emit(ENTROPY_RULE_ID, `high-entropy string (~${entropy.toFixed(2)} bits/char)`, "warning", start, value.length, value);
    }
  }

  return findings;
}
