/**
 * Trust policy, always read from the base revision (#2524 D5, Threat model;
 * ws-001, ws-002).
 *
 * A check reads who may sign, and who holds which role, from the target
 * branch tip or `--base <rev>`, never from the change under review. A change
 * can edit its own copy of these files, and those edits have no effect until
 * they are merged: the change is still judged by the policy at base. Editing
 * the policy is itself a protected write (see ./verify.ts).
 *
 * Two files, both optional:
 *
 * - `.chant/allowed_signers` holds the signers, in ssh-keygen's
 *   allowed_signers format, so `git log --show-signature` can use the same
 *   file. `trust.json` may name another path.
 * - `.chant/trust.json` holds the override for the signers path, the role
 *   grants and the adopted commit ranges. Role grants move into
 *   `chant.workspace.json` once the declaration exists (#2534).
 *
 * Attestation is opt-in (#2525 rule 6). Without a signers file at base,
 * nothing is verified and every record is `unattested`.
 */

import { posix } from "node:path";
import { z } from "zod";
import type { RecordSource } from "../record-source";

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

// ── trust.json ───────────────────────────────────────────────────────────────

const fullCommit = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "a full commit id");

/** A repository-relative path: no `..`, not absolute, `/` separators. */
const repoPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.includes("\\") && posix.normalize(p) === p && !p.split("/").includes(".."), {
    message: "a path inside the repository, with / separators and no ..",
  });

export const trustConfigSchema = z
  .object({
    schema: z.literal(1),
    /** Where the signers file is, instead of `.chant/allowed_signers`. */
    signers: repoPath.optional(),
    /**
     * Role name to the principals holding it. Until #2534 these live here;
     * then they move into the declaration.
     */
    roles: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), z.array(z.string().min(1))).optional(),
    /**
     * Commit ranges admitted without signatures (#2524 D5, adoption). Each is
     * exact: `to` and, when given, `from` are full commit ids, and the range is
     * the commits `from..to`.
     */
    adopted: z.array(z.object({ from: fullCommit.optional(), to: fullCommit, note: z.string().optional() }).strict()).optional(),
  })
  .strict();

export type TrustConfig = z.infer<typeof trustConfigSchema>;

/** The role whose holders may change the policy. Without any grant of it, every signer may. */
export const ADMIN_ROLE = "admin";

/** The policy a check applies, as read at base. */
export interface TrustPolicy {
  /** The full commit id the policy was read at, or null when there is no base. */
  base: string | null;
  /** The signers path used. */
  signersPath: string;
  /** Whether a signers file exists at base. False means attestation is off. */
  active: boolean;
  signers: Signer[];
  excluded: ExcludedSigner[];
  roles: Record<string, string[]>;
  adopted: Array<{ from?: string; to: string }>;
  /** Why the policy could not be read, when it could not. Nothing verifies then. */
  problems: string[];
}

/** Paths whose change is a protected write under `policy`. */
export function protectedPaths(policy: TrustPolicy): string[] {
  return [...new Set([TRUST_CONFIG_PATH, policy.signersPath])].sort();
}

/** Principals allowed to change the policy: the admins when any are granted, otherwise every signer. */
export function policyWriters(policy: TrustPolicy): Set<string> {
  const admins = policy.roles[ADMIN_ROLE];
  if (admins && admins.length > 0) return new Set(admins);
  return new Set(policy.signers.map((s) => s.principal));
}

/** A policy with nothing in it: attestation off. */
export function emptyPolicy(base: string | null, problems: string[] = []): TrustPolicy {
  return { base, signersPath: DEFAULT_SIGNERS_PATH, active: false, signers: [], excluded: [], roles: {}, adopted: [], problems };
}

/**
 * Read the policy through `source`, which must read the base revision.
 * Never throws: a policy that cannot be read yields an inactive policy with
 * its problems listed, so nothing is attested (fail closed).
 */
export function readTrustPolicy(source: RecordSource, base: string | null): TrustPolicy {
  let config: TrustConfig = { schema: 1 };
  const configText = readOptional(source, TRUST_CONFIG_PATH);
  if (configText !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(configText);
    } catch (err) {
      return emptyPolicy(base, [`${TRUST_CONFIG_PATH} is not JSON: ${err instanceof Error ? err.message : String(err)}`]);
    }
    const parsed = trustConfigSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "/"}: ${i.message}`).join("; ");
      return emptyPolicy(base, [`${TRUST_CONFIG_PATH} is invalid: ${detail}`]);
    }
    config = parsed.data;
  }
  const signersPath = config.signers ?? DEFAULT_SIGNERS_PATH;
  const text = readOptional(source, signersPath);
  const set = text === undefined ? { signers: [], excluded: [] } : parseAllowedSigners(text);
  return {
    base,
    signersPath,
    active: text !== undefined,
    signers: set.signers,
    excluded: set.excluded,
    roles: config.roles ?? {},
    adopted: config.adopted ?? [],
    problems: [],
  };
}

/** A file's text through `source`, or undefined when it is not there. */
export function readOptional(source: RecordSource, path: string): string | undefined {
  const dir = posix.dirname(path);
  const names = source.list(dir);
  if (!names || !names.includes(posix.basename(path))) return undefined;
  return source.read(path);
}
