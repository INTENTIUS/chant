/**
 * The trust files' plain readers (#3763): the signers file's parser, and a
 * check of `.chant/trust.json` that says what `./policy.ts`'s zod schema
 * says, so a bundle can read both without zod. `./policy.ts` re-exports the
 * parser; `trust-files.test.ts` holds the check to the schema.
 */

import { posix } from "node:path";

/** The trust config, relative to the repository root. Fixed: it is how the signers path is overridden. */
export const TRUST_CONFIG_PATH = ".chant/trust.json";

/** Where the signers are when `trust.json` names no other path. */
export const DEFAULT_SIGNERS_PATH = ".chant/allowed_signers";

// ── allowed_signers ──────────────────────────────────────────────────────────

/** Key types ssh-keygen accepts in an allowed_signers line. */
const KEY_TYPES = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
]);

/** One usable signer: a principal and the public key it signs with. */
export interface Signer {
  principal: string;
  /** `<type> <base64>`, with no comment. */
  key: string;
  /** The `namespaces="..."` option as written, or undefined when the key may sign any namespace. */
  namespaces?: string;
  /** 1-based line in the signers file. */
  line: number;
}

/** A line of the signers file that is not used, and why. */
export interface ExcludedSigner {
  line: number;
  reason: string;
}

export interface SignerSet {
  signers: Signer[];
  excluded: ExcludedSigner[];
}

/**
 * Split one line into fields. Double quotes group, so an option such as
 * `namespaces="git,file"` stays one field.
 */
function fields(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let any = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      cur += ch;
      any = true;
    } else if (!quoted && (ch === " " || ch === "\t")) {
      if (any) out.push(cur);
      cur = "";
      any = false;
    } else {
      cur += ch;
      any = true;
    }
  }
  if (any) out.push(cur);
  return out;
}

/** `a="x,y",b` as `{ a: "x,y", b: "" }`. */
function options(field: string): Map<string, string> {
  const opts = new Map<string, string>();
  let cur = "";
  let quoted = false;
  const flush = () => {
    if (!cur) return;
    const eq = cur.indexOf("=");
    const name = (eq < 0 ? cur : cur.slice(0, eq)).toLowerCase();
    const value = eq < 0 ? "" : cur.slice(eq + 1).replace(/^"|"$/g, "");
    opts.set(name, value);
    cur = "";
  };
  for (const ch of field) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) flush();
    else cur += ch;
  }
  flush();
  return opts;
}

/**
 * Parse an allowed_signers file, keeping only lines whose meaning does not
 * depend on anything the signer controls.
 *
 * Refused, each with a reason, rather than passed to ssh-keygen:
 *
 * - `valid-after` and `valid-before`. git checks them against the commit's own
 *   date, which whoever makes the commit sets. A backdated commit would pass a
 *   window its key has left. Revocation is by position in history (#2553),
 *   never by date.
 * - `cert-authority`. A certificate's validity is also a date, and a CA key
 *   vouches for keys this file never names.
 * - Principal patterns (`*`, `?`, `!`). A signer is named by one exact
 *   principal, so role grants can name it.
 */
export function parseAllowedSigners(text: string): SignerSet {
  const signers: Signer[] = [];
  const excluded: ExcludedSigner[] = [];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    const f = fields(raw);
    if (f.length < 3) {
      excluded.push({ line, reason: "expected principals, optional options, a key type and a key" });
      continue;
    }
    const [principals, second] = f;
    const hasOptions = !KEY_TYPES.has(second);
    const type = hasOptions ? f[2] : second;
    const blob = hasOptions ? f[3] : f[2];
    if (!KEY_TYPES.has(type) || !blob || !/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) {
      excluded.push({ line, reason: `no supported public key (${type ?? "none"})` });
      continue;
    }
    const opts = hasOptions ? options(second) : new Map<string, string>();
    const timed = ["valid-after", "valid-before"].filter((o) => opts.has(o));
    if (timed.length > 0) {
      excluded.push({
        line,
        reason: `${timed.join(" and ")} is checked against the commit's own date, which its author sets; revoke a key by removing it`,
      });
      continue;
    }
    if (opts.has("cert-authority")) {
      excluded.push({ line, reason: "cert-authority keys are not supported: a certificate's validity is a date the signer controls" });
      continue;
    }
    const unknown = [...opts.keys()].filter((o) => o !== "namespaces");
    if (unknown.length > 0) {
      excluded.push({ line, reason: `unknown option ${unknown.join(", ")}` });
      continue;
    }
    const names = principals.replace(/^"|"$/g, "").split(",").filter(Boolean);
    const pattern = names.find((p) => /[*?!]/.test(p));
    if (pattern !== undefined || names.length === 0) {
      excluded.push({ line, reason: `principal ${JSON.stringify(pattern ?? principals)} is a pattern; name one signer exactly` });
      continue;
    }
    for (const principal of names) {
      signers.push({ principal, key: `${type} ${blob}`, namespaces: opts.get("namespaces"), line });
    }
  }
  return { signers, excluded };
}

/** The signers as an allowed_signers file ssh-keygen reads, holding only the usable lines. */
export function renderAllowedSigners(signers: Signer[]): string {
  return (
    signers
      .map((s) => `${JSON.stringify(s.principal)}${s.namespaces !== undefined ? ` namespaces=${JSON.stringify(s.namespaces)}` : ""} ${s.key}`)
      .join("\n") + "\n"
  );
}

// ── trust.json, without zod ──────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const FULL_COMMIT = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SSH_ED25519 = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/;
const SSH_KEY = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2}$/;

/** A repository-relative path: no `..`, not absolute, `/` separators. */
export function isRepoPath(p: unknown): p is string {
  return typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.includes("\\") && posix.normalize(p) === p && !p.split("/").includes("..");
}

/** Whether `o` holds only `keys`, as zod's `.strict()` requires. */
const only = (o: Record<string, unknown>, keys: string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const optional = (v: unknown, ok: (v: unknown) => boolean): boolean => v === undefined || ok(v);
const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.length > 0;

/**
 * What is wrong with a parsed `.chant/trust.json`, one line per field, or an
 * empty list when it is valid. It accepts exactly what `trustConfigSchema`
 * in `./policy.ts` accepts, so a reader without zod treats a file as chant
 * does: an invalid one turns attestation off.
 */
export function trustConfigProblems(raw: unknown): string[] {
  if (!isObject(raw)) return ["/: expected an object"];
  const problems: string[] = [];
  const check = (field: string, ok: boolean, message: string) => {
    if (!ok) problems.push(`${field}: ${message}`);
  };
  check("/", only(raw, ["schema", "signers", "roles", "adopted", "runners", "passkeys", "admitted"]), "unknown key");
  check("schema", raw.schema === 1, "expected 1");
  check("signers", optional(raw.signers, isRepoPath), "a path inside the repository, with / separators and no ..");
  check(
    "roles",
    optional(raw.roles, (r) => isObject(r) && Object.entries(r).every(([k, v]) => /^[a-z][a-z0-9-]*$/.test(k) && Array.isArray(v) && v.every(nonEmpty))),
    "role names to lists of principals",
  );
  check(
    "adopted",
    optional(raw.adopted, (a) =>
      Array.isArray(a) &&
      a.every((e) => isObject(e) && only(e, ["from", "to", "note"]) && optional(e.from, (f) => typeof f === "string" && FULL_COMMIT.test(f)) && typeof e.to === "string" && FULL_COMMIT.test(e.to) && optional(e.note, (n) => typeof n === "string")),
    ),
    "commit ranges of full commit ids",
  );
  check(
    "runners",
    optional(raw.runners, (a) =>
      Array.isArray(a) &&
      a.every((e) => isObject(e) && only(e, ["principal", "class", "key"]) && nonEmpty(e.principal) && (e.class === "runner" || e.class === "service") && typeof e.key === "string" && SSH_ED25519.test(e.key)),
    ),
    "runner keys: a principal, a class and an ssh-ed25519 key",
  );
  const b64url = (v: unknown): boolean => typeof v === "string" && /^[A-Za-z0-9_-]+$/.test(v);
  check(
    "passkeys",
    optional(raw.passkeys, (a) =>
      Array.isArray(a) &&
      a.every(
        (e) =>
          isObject(e) && only(e, ["principal", "id", "publicKey", "rpId", "origins"]) &&
          nonEmpty(e.principal) && b64url(e.id) && b64url(e.publicKey) && nonEmpty(e.rpId) &&
          Array.isArray(e.origins) && e.origins.length > 0 && e.origins.every(nonEmpty),
      ),
    ),
    "passkeys: a principal, a credential id, a public key, an rpId and origins",
  );
  check(
    "admitted",
    optional(raw.admitted, (a) =>
      Array.isArray(a) &&
      a.every(
        (e) =>
          isObject(e) && only(e, ["return", "signers", "note"]) &&
          typeof e.return === "string" && /^ret-[0-9a-f]{12}$/.test(e.return) &&
          optional(e.note, (n) => typeof n === "string") &&
          Array.isArray(e.signers) && e.signers.length > 0 &&
          e.signers.every((s) => isObject(s) && only(s, ["principal", "key"]) && nonEmpty(s.principal) && typeof s.key === "string" && SSH_KEY.test(s.key)),
      ),
    ),
    "admitted signers, by return id",
  );
  return problems;
}
