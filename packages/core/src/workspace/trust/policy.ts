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
import { DEFAULT_SIGNERS_PATH, TRUST_CONFIG_PATH, parseAllowedSigners, type ExcludedSigner, type Signer } from "./trust-files";
import type { PasskeySigner } from "../../lifecycle/gate-webauthn";

export {
  DEFAULT_SIGNERS_PATH,
  TRUST_CONFIG_PATH,
  parseAllowedSigners,
  renderAllowedSigners,
  type ExcludedSigner,
  type Signer,
  type SignerSet,
} from "./trust-files";

// ── trust.json ───────────────────────────────────────────────────────────────

const fullCommit = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "a full commit id");

/** A repository-relative path: no `..`, not absolute, `/` separators. */
const repoPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.includes("\\") && posix.normalize(p) === p && !p.split("/").includes(".."), {
    message: "a path inside the repository, with / separators and no ..",
  });

/** A check name a ref rule requires (#4867): it is also part of an override's subject. */
export const REF_CHECK_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** A ref pattern (#4867): a full ref name, where `*` matches within one `/` segment and `**` matches across them. */
export const REF_PATTERN = /^refs\/[^\s\\]+$/;

/**
 * Checks local evidence never stands in for (#4868): the ones that gate an
 * apply, a release or a gate. A name is refused when it is one of these, or
 * one of these followed by `:` (a wave's `plan:<wave>`).
 */
export const LOCAL_EVIDENCE_NEVER = ["plan", "policy", "apply", "drift", "release", "gate", "approval", "confirm"] as const;

/** Whether local evidence may ever be accepted for `check` (#4868). */
export function localEvidenceAllowedFor(check: string): boolean {
  return !LOCAL_EVIDENCE_NEVER.some((n) => check === n || check.startsWith(`${n}:`));
}

/** Who signs local evidence (#4868): a person on their machine, or an agent session as itself. */
export const LOCAL_SIGNER_CLASSES = ["person", "agent"] as const;
export type LocalSignerClass = (typeof LOCAL_SIGNER_CLASSES)[number];

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
    /**
     * Keys that sign runner evidence (#2553). Each belongs to a service or a CI
     * identity, never to a person: a key or principal the signers file lists
     * is refused here.
     */
    runners: z
      .array(
        z
          .object({
            principal: z.string().min(1),
            class: z.enum(["runner", "service"]),
            key: z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/, "an ssh-ed25519 public key, with no comment"),
          })
          .strict(),
      )
      .optional(),
    /**
     * Passkeys that sign gate approvals for people (#4646): a WebAuthn
     * credential's id, its public key as base64url DER SubjectPublicKeyInfo,
     * the relying party id and the origins an assertion may come from. A
     * passkey signs only a gate approval (`chant approve --signature`).
     */
    passkeys: z
      .array(
        z
          .object({
            principal: z.string().min(1),
            id: z.string().regex(/^[A-Za-z0-9_-]+$/, "a credential id, base64url with no padding"),
            publicKey: z.string().regex(/^[A-Za-z0-9_-]+$/, "a DER SubjectPublicKeyInfo, base64url with no padding"),
            rpId: z.string().min(1),
            origins: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .optional(),
    /**
     * Signers admitted for the work one return brought back (#2552, D10,
     * ws-004). Each entry names the return by its id (the file
     * `.chant/returns/<id>.json` the import wrote) and the keys it admits.
     * An admitted key verifies only the returned commits and seals of that
     * return, never a commit made in this repository.
     */
    admitted: z
      .array(
        z
          .object({
            return: z.string().regex(/^ret-[0-9a-f]{12}$/, "a return id, ret-<12 hex>"),
            signers: z
              .array(
                z
                  .object({
                    principal: z.string().min(1),
                    key: z.string().regex(/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/]+={0,2}$/, "an ssh public key, with no comment"),
                  })
                  .strict(),
              )
              .min(1),
            note: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
    /**
     * The checks a ref update must carry evidence for (#4867). Each entry
     * names a ref pattern and the checks a commit pushed there needs current
     * runner evidence of, each with what to do without it (`block` refuses
     * the update, `warn` admits it and says what was missing) and the command
     * that produces it. `status` is the commit status a forge requires, by
     * default `chant/ref-gate`. `overrides` says how an override is judged:
     * `sealed` when the signers file at base exists, else `ledger`.
     */
    refs: z
      .array(
        z
          .object({
            ref: z.string().regex(REF_PATTERN, "a full ref name such as refs/heads/main, where * and ** match"),
            checks: z
              .array(
                z
                  .object({
                    check: z.string().regex(REF_CHECK_NAME, "a check name: letters, digits, . _ : -"),
                    action: z.enum(["block", "warn"]).optional(),
                    command: z.string().min(1),
                  })
                  .strict(),
              )
              .min(1),
            status: z.string().min(1).optional(),
            overrides: z.enum(["ledger", "sealed"]).optional(),
          })
          .strict(),
      )
      .optional(),
    /**
     * Local evidence (#4868): keys that sign on a developer's machine, for a
     * person or an agent session, and the checks whose CI run such evidence
     * stands in for. Off for every check not named in `checks`, and never
     * for the checks {@link LOCAL_EVIDENCE_NEVER} names. A local key is
     * never a runner key: local evidence never counts as runner evidence.
     */
    local: z
      .object({
        keys: z
          .array(
            z
              .object({
                principal: z.string().min(1),
                class: z.enum(LOCAL_SIGNER_CLASSES),
                key: z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/, "an ssh-ed25519 public key, with no comment"),
              })
              .strict(),
          )
          .optional(),
        checks: z
          .array(
            z
              .object({
                check: z
                  .string()
                  .regex(REF_CHECK_NAME, "a check name: letters, digits, . _ : -")
                  .refine(localEvidenceAllowedFor, { message: `local evidence never stands in for ${LOCAL_EVIDENCE_NEVER.join(", ")} (or <name>:<wave>)` }),
                from: z.array(z.enum(LOCAL_SIGNER_CLASSES)).min(1).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type TrustConfig = z.infer<typeof trustConfigSchema>;

/** The role whose holders may change the policy. Without any grant of it, every signer may. */
export const ADMIN_ROLE = "admin";

/** A ref rule of `.chant/trust.json` (#4867), with `action` filled in. */
export interface RefRule {
  ref: string;
  checks: Array<{ check: string; action: "block" | "warn"; command: string }>;
  status?: string;
  overrides?: "ledger" | "sealed";
}

/** A key that signs local evidence (#4868): a person's or an agent session's. */
export interface LocalKey {
  principal: string;
  class: LocalSignerClass;
  /** `ssh-ed25519 <base64>`. */
  key: string;
}

/** What `local` in `.chant/trust.json` at base says (#4868), with `from` filled in (default: people only). */
export interface LocalEvidencePolicy {
  keys: LocalKey[];
  /** Keys left out, and why. */
  excluded: Array<{ principal: string; reason: string }>;
  /** The checks local evidence stands in for, and from whom. */
  checks: Array<{ check: string; from: LocalSignerClass[] }>;
}

/** A key that signs runner evidence: a service or CI identity. */
export interface RunnerKey {
  principal: string;
  class: "runner" | "service";
  /** `ssh-ed25519 <base64>`. */
  key: string;
}

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
  /** Runner and service keys that may sign runner evidence (#2553). */
  runners: RunnerKey[];
  /** Runner entries that are not used, and why. */
  excludedRunners: Array<{ principal: string; reason: string }>;
  /** Passkeys that sign people's gate approvals (#4646). Absent on a policy built by hand: none. */
  passkeys?: PasskeySigner[];
  /** Signers admitted per return (#2552), keyed by return id. They verify that return's commits and seals only. */
  admitted: Record<string, Signer[]>;
  /** The checks a ref update needs evidence for (#4867). Absent on a policy built by hand: none. */
  refs?: RefRule[];
  /** Local evidence (#4868). Absent on a policy built by hand: no key, no check accepts it. */
  local?: LocalEvidencePolicy;
  /**
   * Set on a copy of the policy used for one returned record (#2552): the
   * return it came back in. A seal by a principal the policy does not list
   * then reads as unverifiable rather than unlisted, until an admin admits
   * the signer. Never set on the policy read at base.
   */
  returnedFrom?: string;
  /** Why the policy could not be read, when it could not. Nothing verifies then. */
  problems: string[];
  /**
   * The signer set in effect at a commit's position in the base's history
   * (#2553). Absent, every commit is judged by `signers`.
   */
  signersAt?: (commit: string) => { version: number; signers: Signer[] } | null;
}

/** Paths whose change is a protected write under `policy`: the config, the signers file and its rotation file (#2553). */
export function protectedPaths(policy: TrustPolicy): string[] {
  const s = policy.signersPath;
  return [...new Set([TRUST_CONFIG_PATH, s, posix.join(posix.dirname(s), `${posix.basename(s)}.rotation.json`)])].sort();
}

/** Principals allowed to change the policy: the admins when any are granted, otherwise every signer. */
export function policyWriters(policy: TrustPolicy): Set<string> {
  const admins = policy.roles[ADMIN_ROLE];
  if (admins && admins.length > 0) return new Set(admins);
  return new Set(policy.signers.map((s) => s.principal));
}

/** A policy with nothing in it: attestation off. */
export function emptyPolicy(base: string | null, problems: string[] = []): TrustPolicy {
  return { base, signersPath: DEFAULT_SIGNERS_PATH, active: false, signers: [], excluded: [], roles: {}, adopted: [], runners: [], excludedRunners: [], passkeys: [], admitted: {}, refs: [], local: { keys: [], excluded: [], checks: [] }, problems };
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
  // A runner key is a machine's, never a person's (#2553).
  const humanKeys = new Set(set.signers.map((s) => s.key));
  const humanNames = new Set(set.signers.map((s) => s.principal));
  const runners: RunnerKey[] = [];
  const excludedRunners: Array<{ principal: string; reason: string }> = [];
  const all = config.runners ?? [];
  for (const r of all) {
    if (humanKeys.has(r.key) || humanNames.has(r.principal)) {
      excludedRunners.push({ principal: r.principal, reason: `${signersPath} lists this ${humanKeys.has(r.key) ? "key" : "principal"}; runner keys belong to a service or CI identity, never to a signer` });
    } else if (all.filter((o) => o.key === r.key || o.principal === r.principal).length > 1) {
      // One key under two names, or one name with two entries, would leave it unclear who signed.
      excludedRunners.push({ principal: r.principal, reason: "another runner entry has the same key or principal; each runner is one principal with one key" });
    } else {
      runners.push(r);
    }
  }
  return {
    base,
    signersPath,
    active: text !== undefined,
    signers: set.signers,
    excluded: set.excluded,
    roles: config.roles ?? {},
    adopted: config.adopted ?? [],
    runners,
    excludedRunners,
    passkeys: config.passkeys ?? [],
    admitted: admittedOf(config),
    refs: (config.refs ?? []).map((r) => ({ ...r, checks: r.checks.map((c) => ({ ...c, action: c.action ?? "block" })) })),
    local: localOf(config, runners),
    problems: [],
  };
}

/** The local evidence policy (#4868): a key a runner entry also holds is left out, so one key never speaks as both. */
function localOf(config: TrustConfig, runners: readonly RunnerKey[]): LocalEvidencePolicy {
  const runnerKeys = new Set([...runners.map((r) => r.key), ...(config.runners ?? []).map((r) => r.key)]);
  const all = config.local?.keys ?? [];
  const keys: LocalKey[] = [];
  const excluded: Array<{ principal: string; reason: string }> = [];
  for (const k of all) {
    if (runnerKeys.has(k.key)) excluded.push({ principal: k.principal, reason: "a runner entry has this key; local evidence is signed by a person's or an agent's key, never a runner's" });
    else if (all.filter((o) => o.key === k.key || o.principal === k.principal).length > 1) excluded.push({ principal: k.principal, reason: "another local key has the same key or principal" });
    else keys.push(k);
  }
  return { keys, excluded, checks: (config.local?.checks ?? []).map((c) => ({ check: c.check, from: c.from ?? ["person"] })) };
}

/** The admitted signers, by return id. Two entries for one return add up. */
function admittedOf(config: TrustConfig): Record<string, Signer[]> {
  const out: Record<string, Signer[]> = {};
  for (const a of config.admitted ?? []) {
    out[a.return] = [...(out[a.return] ?? []), ...a.signers.map((s) => ({ principal: s.principal, key: s.key, line: 0 }))];
  }
  return out;
}

/**
 * The policy for work that came back in return `id` (#2552): the signers at
 * base plus the ones admitted for that return, marked with the return so a
 * seal by an unknown signer reads as unverifiable.
 */
export function returnedPolicy(policy: TrustPolicy, id: string): TrustPolicy {
  return { ...policy, signers: [...policy.signers, ...(policy.admitted[id] ?? [])], returnedFrom: id };
}

/** A file's text through `source`, or undefined when it is not there. */
export function readOptional(source: RecordSource, path: string): string | undefined {
  const dir = posix.dirname(path);
  const names = source.list(dir);
  if (!names || !names.includes(posix.basename(path))) return undefined;
  return source.read(path);
}
