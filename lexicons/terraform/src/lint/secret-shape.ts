/**
 * The two heuristics the secrets rules of the TF family share: does this
 * attribute's NAME read like a credential, and does its VALUE look like one.
 *
 * tfsec shipped `general-secrets-sensitive-in-variable`,
 * `-in-local` and `-in-attribute`, and trivy dropped all three when it
 * absorbed tfsec, so no maintained tool checks them today (#2107's survey).
 * TF007, TF008, TF009 and TF022 are chant's versions, and they only stay
 * consistent with each other if "secret-shaped" means one thing. That is what
 * this module is.
 *
 * Nothing here re-implements a detector `packages/core/src/audit/secrets.ts`
 * already has. The value heuristic runs a candidate through `scanForSecrets`
 * first, so every vendor prefix the SEC family knows (AWS key ids, GitHub,
 * Slack, Google, Stripe), the PEM block shape and the connection-string shape
 * are recognised here for free, and it reuses that module's placeholder
 * vocabulary, its identifier-slug filter and its entropy function. What it
 * adds is what a Terraform attribute needs and a raw text scan does not: the
 * JWT and bare PEM-header shapes, and a lower length floor than SEC010's 24
 * characters, because an attribute value is already a single token rather
 * than a line of prose to fish tokens out of.
 */

import {
  looksLikeIdentifierSlug,
  looksLikePlaceholder,
  scanForSecrets,
  shannonEntropy,
} from "@intentius/chant/audit/secrets";

/**
 * Credential words, matched against the whole attribute name on `_`
 * boundaries, so `db_password` and `access_key` match but `keystore` and
 * `tokenizer` do not.
 */
const SECRET_NAME_RE = /(^|_)(password|passwd|secret|token|api_key|private_key|access_key)(_|$)/;

/**
 * Suffixes that turn a credential word into a REFERENCE to a credential:
 * `secret_arn`, `db_password_file`, `api_key_id`, `private_key_path`,
 * `token_name`. The value under one of these is a locator, and a locator is
 * exactly what the fix for the other rules asks for, so flagging it would
 * flag the remediation.
 */
const LOCATOR_SUFFIX_RE = /_(file|path|arn|id|name)$/;

/** Minimum length for a value to be worth judging at all. */
export const MIN_SECRET_LENGTH = 8;

/** Minimum length for the generic high-entropy shape (below it, entropy says nothing). */
const MIN_ENTROPY_LENGTH = 16;

/** Bits per character above which a token of that length reads as random. */
const ENTROPY_THRESHOLD = 3.5;

/** `eyJ...header.eyJ...payload.signature`. An unsigned JWT still carries claims. */
const JWT_RE = /^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]*)?$/;

/** A PEM header on its own, without the closing block `scanForSecrets` requires. */
const PEM_HEADER_RE = /-----BEGIN ([A-Z]+ )?PRIVATE KEY-----/;

/** Normalize an attribute or variable name for the name heuristic. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Does this attribute or variable name read like a credential? Case-insensitive
 * and word-bounded, with the locator suffixes excluded.
 */
export function isSecretName(name: string): boolean {
  const normalized = normalizeName(name);
  if (LOCATOR_SUFFIX_RE.test(normalized)) return false;
  return SECRET_NAME_RE.test(normalized);
}

/**
 * Is this a plain string literal, as opposed to an expression? `hcl2json`
 * renders every expression as a `"${...}"` template, so a value carrying one
 * is a reference (`var.db_password`, `data.aws_secretsmanager_secret_version.x.secret_string`)
 * or an interpolation, never a committed constant. Those are the fix, not the
 * finding.
 */
export function isLiteralString(value: unknown): value is string {
  return typeof value === "string" && !value.includes("${");
}

/**
 * A placeholder rather than a credential. Core's list is checked twice: once
 * as written, once with separators stripped, so the `CHANGE_ME` and
 * `YOUR_API_KEY` spellings land on the same `changeme` / `your-api-key`
 * entries as the unseparated ones.
 */
export function isPlaceholderValue(value: string): boolean {
  return looksLikePlaceholder(value) || looksLikePlaceholder(value.replace(/[-_\s]/g, ""));
}

/** At least 3 of {lower, upper, digit, symbol}, which cuts plain words and pure hex. */
function hasClassDiversity(value: string): boolean {
  let classes = 0;
  if (/[a-z]/.test(value)) classes++;
  if (/[A-Z]/.test(value)) classes++;
  if (/[0-9]/.test(value)) classes++;
  if (/[^A-Za-z0-9]/.test(value)) classes++;
  return classes >= 3;
}

/** The generic shape: a long, diverse, high-entropy token that isn't a slug. */
function isHighEntropyToken(value: string): boolean {
  if (value.length < MIN_ENTROPY_LENGTH) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) return false;
  if (!hasClassDiversity(value)) return false;
  if (looksLikeIdentifierSlug(value)) return false;
  return shannonEntropy(value) >= ENTROPY_THRESHOLD;
}

/**
 * Does this value look like a live credential on its own, whatever it is
 * called? A known vendor shape (through core's detectors), a JWT, a PEM key,
 * or a high-entropy token.
 */
export function isCredentialShapedValue(value: unknown): boolean {
  if (!isLiteralString(value)) return false;
  if (value.length < MIN_SECRET_LENGTH) return false;
  if (isPlaceholderValue(value)) return false;
  if (JWT_RE.test(value)) return true;
  if (PEM_HEADER_RE.test(value)) return true;
  // Core's own scan, over the single value: every SEC00x detector plus its
  // high-entropy catch-all, with no file to walk.
  if (scanForSecrets([{ path: "value", content: value }]).length > 0) return true;
  return isHighEntropyToken(value);
}

/** Which heuristic fired, so a diagnostic can say why it is complaining. */
export type SecretShapeReason = "name" | "value";

export interface SecretShape {
  reason: SecretShapeReason;
  /** The value's length, for a message that never quotes the value itself. */
  length: number;
}

/**
 * The combined test the rules use: is `value`, assigned to an attribute called
 * `name`, a committed secret? Either heuristic is enough, but both sides of the
 * gate are the same, since the value has to be a literal, long enough to be a
 * credential, and not a placeholder, so `sensitive = true`-style
 * remediation advice is never given for `password = "changeme"`.
 *
 * Findings never carry the value. Callers get the reason and the length.
 */
export function secretShapedAssignment(name: string, value: unknown): SecretShape | undefined {
  if (!isLiteralString(value)) return undefined;
  if (value.length < MIN_SECRET_LENGTH) return undefined;
  if (isPlaceholderValue(value)) return undefined;
  if (isCredentialShapedValue(value)) return { reason: "value", length: value.length };
  if (isSecretName(name)) return { reason: "name", length: value.length };
  return undefined;
}
