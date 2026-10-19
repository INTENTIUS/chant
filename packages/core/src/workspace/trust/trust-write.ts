/**
 * `chant workspace trust runner add <principal> --key <key>` and `chant
 * workspace trust runner remove <principal>` (#3510): a runner entry of
 * `.chant/trust.json`, written through chant.
 *
 * ws-074 lets a tool write the repo only through chant. A lobby that signs
 * agent-run statements, a CI job that signs Op runs and ci tags, and a host
 * running `chant ci serve` each need their key under `runners`, and before
 * this write a box repo added that entry by hand. `add` lists the key for the
 * principal and, for class `runner`, grants the principal the `runner` role
 * that `ci tick`, `ci run` and `chant run --key` require. `remove` takes both
 * away. The file is edited in place, so its formatting and key order stay as
 * they were.
 *
 * The write is a working-tree write like `member add`: it holds the write
 * lock (#3173, ws-089), is judged by the write scope at base, notes who wrote
 * the file in the write journal, and never commits. Changing the trust
 * config is a protected write, so the commit that carries it is checked by
 * `chant workspace verify` against the policy at base. `--expect <digest>`
 * refuses the write when the file has changed since the caller read it: the
 * digest is the SHA-256 of the file's bytes, and of empty text when there is
 * no file. Each write prints one JSON document (`trust-write.schema.json`)
 * with the digest after the write, to pass as `--expect` to the next one.
 */

import { createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { CommandContext } from "../../cli/registry";
import { readerVersion } from "../declaration";
import { IDENTITY_CODES, IdentityError, refuseUnidentified } from "../identity";
import { appendElement, removeElement, setProperty } from "../json-edit";
import { parseJsonText } from "../jsonc";
import type { ReasonCode } from "../reason-codes";
import { gitRoot } from "../record-source";
import { AGENT_ENV, judgePath, resolveWriter, scopeSource, unknownClassVerdict, WriteScopeError } from "../write-scope";
import { lastWriteReader, noteWrites, sha256Text, withWriteLockSync, writeFileAtomic, WriteLockError, WRITE_LOCK_CODES, type LastWrite } from "../write-lock";
import { CI_TAG_SIGNER_ROLE } from "./ci-tag-statement";
import { ed25519FromSsh, sshFromEd25519 } from "./dsse";
import { DEFAULT_SIGNERS_PATH, TRUST_CONFIG_PATH, parseAllowedSigners, trustConfigSchema, type RunnerKey, type TrustConfig } from "./policy";

/** The version of the document these writes print. */
export const TRUST_WRITE_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for what the trust writes print, shipped in `workspace/`. */
export const TRUST_WRITE_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/trust-write/v1/trust-write.schema.json";

export const TRUST_WRITE_ACTIONS = ["runner add", "runner remove"] as const;
export type TrustWriteAction = (typeof TRUST_WRITE_ACTIONS)[number];

/** Why a trust write wrote nothing. Closed. */
export const TRUST_WRITE_ERROR_CODES = [
  "not-a-git-repository",
  "write-usage-invalid",
  "trust-config-invalid",
  "trust-conflict",
  "runner-key-invalid",
  "runner-key-is-signer",
  "runner-exists",
  "runner-unknown",
  "write-scope-member",
  "write-scope-protected",
  "write-scope-class-unknown",
  "agent-unknown",
  ...IDENTITY_CODES,
  ...WRITE_LOCK_CODES,
] as const satisfies readonly ReasonCode[];
export type TrustWriteErrorCode = (typeof TRUST_WRITE_ERROR_CODES)[number];

type Head = { $schema: string; contract: number; chant: string; action: TrustWriteAction; name: string | null };

/** What `--expect` disagreed with: the digest the file has now, and its last chant write when the journal knows it. */
export interface TrustConflict {
  path: string;
  expected: string;
  digest: string;
  lastWrite: LastWrite | null;
}

/** What `trust runner add` and `trust runner remove` print. */
export type TrustWriteDocument =
  | (Head & {
      name: string;
      /** `.chant/trust.json`, from the repository root. */
      path: string;
      /** The SHA-256 of the file's bytes after the write (or as they would be, with dryRun): the next write's `--expect`. */
      digest: string;
      /** The SHA-256 of the file's bytes before the write; of empty text when there was no file. */
      previousDigest: string;
      /** The file, when the write changed it; else empty. */
      paths: string[];
      changed: boolean;
      dryRun: boolean;
      /** The runner entry before the write, or null when there was none. */
      previous: RunnerKey | null;
      /** The runner entry after the write, or null after a remove. */
      entry: RunnerKey | null;
      /** Whether the principal holds the `runner` role after the write. */
      runnerRole: boolean;
    })
  | (Head & { error: { code: TrustWriteErrorCode; message: string }; conflict?: TrustConflict });

export interface TrustWriteRequest {
  cwd: string;
  action: TrustWriteAction;
  /** The runner's principal. */
  name: string;
  /** For `runner add`: the public key, as an `ssh-ed25519` line or a file holding one or an Ed25519 PEM. */
  key?: string;
  /** For `runner add`: `runner` (the default) or `service`. */
  runnerClass?: string;
  /** Who is writing (`--by`). */
  by?: string;
  /** The agent session (`CHANT_AGENT`). */
  agent?: string;
  /** The file's digest the caller last read (`--expect`). */
  expect?: string;
  dryRun?: boolean;
}

class TrustWriteError extends Error {
  constructor(
    readonly code: TrustWriteErrorCode,
    message: string,
    readonly conflict?: TrustConflict,
  ) {
    super(message);
  }
}

const toPosix = (p: string) => (sep === "/" ? p : p.split(sep).join("/"));
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a: string, b: string) => a.normalize("NFKC").trim().toLowerCase() === b.normalize("NFKC").trim().toLowerCase();

/** The digest `--expect` compares: the SHA-256 of the file's text, of empty text when there is none. */
export function trustDigest(text: string | null): string {
  return sha256Text(text ?? "");
}

/**
 * The `ssh-ed25519 <base64>` line, with no comment, for what `--key` gives:
 * the line itself (a comment after it is dropped), or a file holding such a
 * line or an Ed25519 key in PEM, public or private, whose public half is
 * used. Throws `runner-key-invalid` for anything else, so only a key the
 * readers can verify is ever listed.
 */
export function runnerPublicKey(given: string, cwd: string): string {
  const fromLine = (line: string, where: string): string => {
    const [type, blob] = line.trim().split(/\s+/);
    if (type !== "ssh-ed25519") {
      throw new TrustWriteError("runner-key-invalid", `${where} is a ${type ?? "blank"} key; runner keys are ssh-ed25519, since runners sign with Ed25519`);
    }
    try {
      ed25519FromSsh(`${type} ${blob ?? ""}`);
    } catch (err) {
      throw new TrustWriteError("runner-key-invalid", `${where} is not an ssh-ed25519 public key: ${err instanceof Error ? err.message : String(err)}`);
    }
    return `${type} ${blob}`;
  };
  const trimmed = given.trim();
  if (/^ssh-[a-z0-9-]+\s/.test(trimmed) || /^(ecdsa|sk-)/.test(trimmed)) return fromLine(trimmed, "--key");
  const file = resolve(cwd, given);
  if (!existsSync(file)) {
    throw new TrustWriteError("runner-key-invalid", `--key takes an ssh-ed25519 public key line, or a file holding one or an Ed25519 key in PEM, and ${given} is neither`);
  }
  const text = readFileSync(file, "utf-8");
  if (text.includes("-----BEGIN")) {
    if (text.includes("OPENSSH PRIVATE KEY")) {
      throw new TrustWriteError("runner-key-invalid", `${given} is an OpenSSH private key; give its public half (the .pub file), or a key in PEM as runners use`);
    }
    try {
      const key = createPublicKey(text);
      if (key.asymmetricKeyType !== "ed25519") throw new Error(`it is ${key.asymmetricKeyType}, and runner keys are Ed25519`);
      const jwk = key.export({ format: "jwk" }) as { x: string };
      return sshFromEd25519(Buffer.from(jwk.x, "base64url"));
    } catch (err) {
      throw new TrustWriteError("runner-key-invalid", `${given} is not an Ed25519 key in PEM: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  return fromLine(line ?? "", given);
}

/** Run the write and build the document it prints. Never throws for a refusal. */
export function trustWrite(req: TrustWriteRequest): TrustWriteDocument {
  const head: Head = { $schema: TRUST_WRITE_SCHEMA_ID, contract: TRUST_WRITE_CONTRACT_VERSION, chant: readerVersion(), action: req.action, name: req.name || null };
  try {
    return withWriteLockSync(req.cwd, { verb: `trust ${req.action}`, by: req.by ?? null, agent: req.agent || null }, req.dryRun, () => write(req, head));
  } catch (err) {
    const fail = (code: TrustWriteErrorCode, message: string, conflict?: TrustConflict): TrustWriteDocument => ({ ...head, error: { code, message }, ...(conflict ? { conflict } : {}) });
    if (err instanceof TrustWriteError) return fail(err.code, err.message, err.conflict);
    if (err instanceof WriteScopeError) return fail(err.code as TrustWriteErrorCode, err.message);
    if (err instanceof IdentityError) return fail(err.code, err.message);
    if (err instanceof WriteLockError) return fail(err.code, err.message);
    throw err;
  }
}

function write(req: TrustWriteRequest, head: Head): TrustWriteDocument {
  if (!req.name || /\s/.test(req.name)) throw new TrustWriteError("write-usage-invalid", `${req.action} needs the runner's principal, one word such as ci:acme/app`);
  if (req.expect !== undefined && !/^[0-9a-f]{64}$/.test(req.expect)) {
    throw new TrustWriteError("write-usage-invalid", `--expect takes the trust file's digest, 64 lowercase hex digits as the last trust write printed it, not ${JSON.stringify(req.expect)}`);
  }
  if (req.action === "runner remove" && (req.key !== undefined || req.runnerClass !== undefined)) {
    throw new TrustWriteError("write-usage-invalid", "runner remove takes no --key or --class: it removes the principal's whole entry");
  }
  const runnerClass = req.runnerClass ?? "runner";
  if (runnerClass !== "runner" && runnerClass !== "service") throw new TrustWriteError("write-usage-invalid", `--class is runner or service, not ${runnerClass}`);
  if (req.action === "runner add" && req.key === undefined) throw new TrustWriteError("write-usage-invalid", "runner add needs the runner's public key: --key <ssh-ed25519 line or file>");

  const top = gitRoot(req.cwd);
  if (!top) throw new TrustWriteError("not-a-git-repository", "the trust policy is read from git, and this directory is not in a git repository");
  const file = join(top, TRUST_CONFIG_PATH);
  const before = existsSync(file) ? readFileSync(file, "utf-8") : null;
  const previousDigest = trustDigest(before);
  if (req.expect !== undefined && req.expect !== previousDigest) {
    const lastWrite = before === null ? null : lastWriteReader(top)(TRUST_CONFIG_PATH, before);
    const who = lastWrite ? ` It was last written by chant workspace ${lastWrite.verb}${lastWrite.by ? ` for ${lastWrite.by}` : ""}${lastWrite.agent ? ` in agent session ${lastWrite.agent}` : ""} at ${lastWrite.at}.` : "";
    throw new TrustWriteError(
      "trust-conflict",
      `${TRUST_CONFIG_PATH} has changed since the digest given with --expect (${req.expect}): its digest is now ${previousDigest}.${who} Read it again, and write again with --expect ${previousDigest} if the change still stands`,
      { path: TRUST_CONFIG_PATH, expected: req.expect, digest: previousDigest, lastWrite },
    );
  }

  let config: TrustConfig = { schema: 1 };
  if (before !== null) {
    const parsed = parseJsonText(before, { jsonc: false });
    if (!parsed.ok) throw new TrustWriteError("trust-config-invalid", `${TRUST_CONFIG_PATH} is not JSON: ${parsed.message}`);
    const valid = trustConfigSchema.safeParse(parsed.value);
    if (!valid.success) {
      throw new TrustWriteError("trust-config-invalid", `${TRUST_CONFIG_PATH} is invalid, so chant reads no trust from it: ${valid.error.issues.map((i) => `${i.path.join(".") || "/"}: ${i.message}`).join("; ")}`);
    }
    config = valid.data;
  }
  const runners = config.runners ?? [];
  const index = runners.findIndex((r) => r.principal === req.name);
  const previous = index >= 0 ? (runners[index] as RunnerKey) : null;
  const roleHolders = config.roles?.[CI_TAG_SIGNER_ROLE] ?? [];
  const holds = (list: readonly string[]) => list.some((p) => same(p, req.name));

  // The edit, made twice: in place in the text, and on the value it must read back as.
  let after = before ?? "";
  let expected: Record<string, unknown> = structuredClone(config) as Record<string, unknown>;
  let entry: RunnerKey | null = null;
  if (req.action === "runner add") {
    const key = runnerPublicKey(req.key!, req.cwd);
    entry = { principal: req.name, class: runnerClass, key };
    const signersPath = config.signers ?? DEFAULT_SIGNERS_PATH;
    const signersFile = join(top, signersPath);
    if (existsSync(signersFile)) {
      const signers = parseAllowedSigners(readFileSync(signersFile, "utf-8")).signers;
      if (signers.some((s) => s.key === key)) throw new TrustWriteError("runner-key-is-signer", `${signersPath} lists this key for a person; a runner key belongs to a service or CI identity, never to a signer`);
      if (signers.some((s) => s.principal === req.name)) throw new TrustWriteError("runner-key-is-signer", `${signersPath} lists ${req.name} as a signer; a runner is a service or CI identity, never a signer`);
    }
    const other = runners.find((r) => r.key === key && r.principal !== req.name);
    if (other) throw new TrustWriteError("runner-exists", `${TRUST_CONFIG_PATH} already lists this key for ${other.principal}; each runner is one principal with one key`);
    if (previous && !isDeepStrictEqual(previous, entry)) {
      throw new TrustWriteError(
        "runner-exists",
        `${TRUST_CONFIG_PATH} already lists ${req.name} with ${previous.key === key ? `class ${previous.class}` : "another key"}; remove it first with chant workspace trust runner remove ${req.name}, then add it again`,
      );
    }
    if (before === null) {
      const fresh: Record<string, unknown> = { schema: 1, runners: [entry], ...(runnerClass === "runner" ? { roles: { [CI_TAG_SIGNER_ROLE]: [req.name] } } : {}) };
      after = `${JSON.stringify(fresh, null, 2)}\n`;
      expected = fresh;
    } else {
      if (!previous) {
        if (Array.isArray(config.runners)) after = appendElement(after, false, "/runners", entry);
        else after = setProperty(after, false, "", "runners", [entry]);
        expected.runners = [...runners, entry];
      }
      if (runnerClass === "runner" && !holds(roleHolders)) {
        if (!config.roles) after = setProperty(after, false, "", "roles", { [CI_TAG_SIGNER_ROLE]: [req.name] });
        else if (!config.roles[CI_TAG_SIGNER_ROLE]) after = setProperty(after, false, "/roles", CI_TAG_SIGNER_ROLE, [req.name]);
        else after = appendElement(after, false, `/roles/${CI_TAG_SIGNER_ROLE}`, req.name);
        expected.roles = { ...(config.roles ?? {}), [CI_TAG_SIGNER_ROLE]: [...roleHolders, req.name] };
      }
    }
  } else {
    if (!previous) {
      throw new TrustWriteError("runner-unknown", `${TRUST_CONFIG_PATH} lists no runner ${req.name}; its runners are ${runners.map((r) => r.principal).join(", ") || "none"}`);
    }
    after = removeElement(after, false, "/runners", index);
    expected.runners = runners.filter((_, i) => i !== index);
    // The runner role means nothing without the key, so it goes with the entry.
    for (let i = roleHolders.length - 1; i >= 0; i--) {
      if (same(roleHolders[i]!, req.name)) after = removeElement(after, false, `/roles/${CI_TAG_SIGNER_ROLE}`, i);
    }
    if (holds(roleHolders)) expected.roles = { ...(config.roles ?? {}), [CI_TAG_SIGNER_ROLE]: roleHolders.filter((p) => !same(p, req.name)) };
  }

  const reread = parseJsonText(after, { jsonc: false });
  if (!reread.ok || !isDeepStrictEqual(reread.value, expected)) {
    // An edit that does not read back as the value meant is never written.
    throw new Error(`trust ${req.action}: editing ${TRUST_CONFIG_PATH} in place did not give the config intended; nothing was written`);
  }
  if (!trustConfigSchema.safeParse(reread.value).success) {
    throw new TrustWriteError("trust-config-invalid", `the ${req.action} would make ${TRUST_CONFIG_PATH} invalid; nothing was written`);
  }
  const runnerRole = req.action === "runner add" ? holds((isObject(expected.roles) ? (expected.roles[CI_TAG_SIGNER_ROLE] as string[] | undefined) : undefined) ?? []) : false;

  // The write scope at base, and who --by names.
  const changed = after !== (before ?? "");
  const source = scopeSource(req.cwd);
  if (req.by !== undefined) refuseUnidentified(source, [req.by], "--by", { agent: req.agent });
  if (changed && (source.declaration !== null || (req.agent !== undefined && req.agent !== ""))) {
    const writer = resolveWriter(source.declaration, source.policy, { agent: req.agent || null, principal: req.by ?? null }, source.classes);
    const unknown = unknownClassVerdict(source.declaration, writer, source.classes);
    if (!unknown.ok) throw new WriteScopeError(unknown.code, unknown.message);
    const path = source.rootOnDisk ? toPosix(relative(source.rootOnDisk, file)) : TRUST_CONFIG_PATH;
    const verdict = judgePath(source.declaration, writer, path, { before: () => before ?? "", after: () => after });
    if (!verdict.ok) throw new TrustWriteError(verdict.code as TrustWriteErrorCode, verdict.message);
  }

  if (changed && !req.dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, after);
    noteWrites(top, [{ path: TRUST_CONFIG_PATH, text: after }], { verb: `trust ${req.action}`, by: req.by ?? null, agent: req.agent || null });
  }
  return {
    ...head,
    name: req.name,
    path: TRUST_CONFIG_PATH,
    digest: trustDigest(changed ? after : before),
    previousDigest,
    paths: changed ? [TRUST_CONFIG_PATH] : [],
    changed,
    dryRun: req.dryRun === true,
    previous,
    entry,
    runnerRole,
  };
}

// ── The command line ─────────────────────────────────────────────────────────

const USAGE: Record<TrustWriteAction, string> = {
  "runner add": "chant workspace trust runner add <principal> --key <ssh-ed25519 line or file> [--class runner|service] [--by <principal>] [--expect <digest>] [--dry-run]",
  "runner remove": "chant workspace trust runner remove <principal> [--by <principal>] [--expect <digest>] [--dry-run]",
};

const print = (doc: TrustWriteDocument): number => {
  console.log(JSON.stringify(doc, null, 2));
  return "error" in doc ? 1 : 0;
};

/** `chant workspace trust runner add|remove <principal>`. */
export function runWorkspaceTrust(ctx: CommandContext): number {
  const [, noun, verb, ...rest] = ctx.args.positionals ?? [];
  const action: TrustWriteAction | null = noun === "runner" && verb === "add" ? "runner add" : noun === "runner" && verb === "remove" ? "runner remove" : null;
  const usage = (a: TrustWriteAction, name: string | undefined, message: string): number =>
    print({ $schema: TRUST_WRITE_SCHEMA_ID, contract: TRUST_WRITE_CONTRACT_VERSION, chant: readerVersion(), action: a, name: name ?? null, error: { code: "write-usage-invalid", message: `${message}; ${USAGE[a]}` } });
  if (action === null) {
    const given = [noun, verb].filter(Boolean).join(" ");
    return usage("runner add", rest[0], `chant workspace trust takes runner add <principal> or runner remove <principal>${given ? `, not ${given}` : ""}`);
  }
  const [name, ...extra] = rest;
  if (name === undefined) return usage(action, undefined, `trust ${action} needs the runner's principal`);
  if (extra.length > 0) return usage(action, name, `trust ${action} takes one principal, and was also given ${extra.join(" ")}`);
  const { args } = ctx;
  return print(
    trustWrite({
      cwd: process.cwd(),
      action,
      name,
      ...(args.key !== undefined ? { key: args.key } : {}),
      ...(args.runnerClass !== undefined ? { runnerClass: args.runnerClass } : {}),
      ...(args.by !== undefined ? { by: args.by } : {}),
      ...(args.expect !== undefined ? { expect: args.expect } : {}),
      agent: process.env[AGENT_ENV] || undefined,
      dryRun: args.dryRun === true,
    }),
  );
}
