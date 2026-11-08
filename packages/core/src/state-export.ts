/**
 * A state export behind a gated request (#4762): one version of a state,
 * written to the machine of the person who asks once someone else approved
 * it, and recorded with who exported which version.
 *
 * Engine-neutral. The engine's adapter is a {@link StateVersionSource}: where
 * the state is, the version it holds now, and one version's bytes. The
 * terraform lexicon builds one from a root's backend
 * (`@intentius/chant-lexicon-terraform/state-export`); a Pulumi stack's
 * export (`pulumi stack export --version`) fits the same three calls. The
 * product passes its words: the op the requests wait at, the approve
 * command it prints, the name of the file.
 *
 * A state holds every secret its resources hold, so the export goes to the
 * requester only:
 *
 * - never in CI, where a file can become a job artifact readable by everyone
 *   who can read the repository ({@link CI_MARKERS}), unless the caller
 *   says otherwise;
 * - never inside a git working tree, where it could be committed;
 * - never over a file, and mode 0600. With no `out`, a new private
 *   directory in the system's temp dir.
 *
 * The first call reads the version's metadata only, records the pending
 * request (kind `state-export`, subject the root or stack, fields the
 * location and the version id) and answers `waiting` with the approve
 * command. Once someone other than the requester approved its digest, the
 * next call spends the approval, reads the version, writes the file, and the
 * finished line records the version id and the digest of the bytes written,
 * never their contents. A request exports once.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CHANT_EXIT } from "./exit-codes";
import { gatedOp, type GatedRequestLedger } from "./lifecycle/gated-op";
import type { GatedRequestRules } from "./lifecycle/gated-request";

/** The first chant with the engine-neutral state export (#4762). */
export const STATE_EXPORT_FLOOR = "0.124.77";

/** The version a store holds now. */
export interface StateVersion {
  /** Whether there is a state at all. */
  exists: boolean;
  /** Its id, when the store keeps versions and can give this one back later. */
  versionId?: string;
  /** Why the store keeps no version of it, when it keeps none. */
  off?: string;
}

/** An engine's state, read by version: the adapter a product's engine supplies. */
export interface StateVersionSource {
  /** Where the state is, as messages and the record name it. Never a credential. */
  readonly location: string;
  /** The version the store holds now. */
  current(): Promise<StateVersion>;
  /** Whether the store holds that version, without reading it. */
  hasVersion(id: string): Promise<boolean>;
  /** That version's bytes, or undefined when the store holds no such version. */
  readVersion(id: string): Promise<string | Uint8Array | undefined>;
}

/** The product's words for an export. */
export interface StateExportWords {
  /** The op the requests wait at, such as `tf-state-export`. */
  op: string;
  /** The request's kind. Default `state-export`. */
  kind?: string;
  /** The command that approves a request, as the product prints it. Default chant's `chant approve <op> <subject> --plan <digest>`. */
  approveCommand?: (subject: string, digest: string) => string;
  /** The file's name in its directory. Default `<subject>.<version>.state`, each with what is not a word character replaced. */
  fileName?: (subject: string, version: string) => string;
  /** The prefix of the private directory a default destination is made in. Default `chant-export-`. */
  tmpPrefix?: string;
}

/** The CI variables that mark a job, where an export would become an artifact. */
export const CI_MARKERS: readonly string[] = ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "FORGEJO_ACTIONS", "BUILDKITE", "JENKINS_URL"];

/** The CI marker set in `env`, or undefined when none is. */
export function ciMarker(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string | undefined {
  return CI_MARKERS.find((k) => env[k] !== undefined && env[k] !== "" && env[k] !== "false");
}

/** The git working tree `path` sits in, or undefined. */
export function enclosingWorkTree(path: string): string | undefined {
  let dir = resolve(path);
  try {
    dir = realpathSync(dir);
  } catch {
    // A path that does not exist is walked as given.
  }
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

/** Why an export may not go to `out`, or undefined when it may. */
export function exportRefusal(out: string): string | undefined {
  const abs = resolve(out);
  if (!existsSync(dirname(abs))) return `${dirname(abs)} is not a directory`;
  if (existsSync(abs)) return `${abs} is there already, and an export never writes over a file; name a new one`;
  const tree = enclosingWorkTree(dirname(abs));
  if (tree) return `${abs} is inside the git working tree ${tree}, where a state could be committed; name a path outside it`;
  return undefined;
}

/** A refusal before anything is asked: a version the store does not have, a destination the export may not use. */
export class StateExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateExportError";
  }
}

export interface StateExportInput {
  /** What is exported, and the gate the request waits at: a root, a stack. */
  subject: string;
  /** The requester. Their own approval never counts. */
  by: string;
  source: StateVersionSource;
  /** The version to export. Default the one the store holds now. */
  version?: string;
  /** Where the file goes. Default a new private directory in the system's temp dir. */
  out?: string;
  words: StateExportWords;
  rules: GatedRequestRules;
  /** Where the ledger is. Default the process's. */
  cwd?: string;
  base?: string;
  /** How long a request waits for its approval. Default 48h. */
  expiry?: string;
  now?: string;
  /** The environment the CI markers are read from. Default the process's. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Export in a CI job too. Default false: a CI job refuses. */
  allowCi?: boolean;
  ledger?: GatedRequestLedger;
}

/** How an export ended. `exit` is the code its command exits with. */
export type StateExportOutcome =
  | { status: "written"; exit: 0; digest: string; version: string; location: string; file: string; approvedBy: string; contentDigest: string; recorded: boolean }
  | { status: "waiting"; exit: 3; digest: string; version: string; location: string; command: string }
  /** An approval stands and does not count, such as the requester's own. The request still waits. */
  | { status: "refused"; exit: 3; digest: string; version: string; location: string; command: string; by: string; reason: string }
  /** The request exported already; another export asks again. */
  | { status: "spent"; exit: 1; digest: string; version: string; location: string }
  | { status: "failed"; exit: 1; digest: string; version: string; location: string; error: Error; recorded: boolean };

const sha = (body: string | Uint8Array): string => `sha256:${createHash("sha256").update(body).digest("hex")}`;

const defaultName = (subject: string, version: string): string => `${subject.replace(/[^\w.-]+/g, "_")}.${version.replace(/[^\w.-]+/g, "_")}.state`;

/**
 * Ask for, or with an approval write, one version of a state. Throws
 * {@link StateExportError} before anything is asked when the version or the
 * destination is refused.
 */
export async function exportStateVersion(input: StateExportInput): Promise<StateExportOutcome> {
  const { source, words } = input;
  const env = input.env ?? process.env;
  const marker = input.allowCi ? undefined : ciMarker(env);
  if (marker) throw new StateExportError(`an export goes to the requester's machine only, and ${marker} is set, so this is a CI job whose files can become artifacts; ask for it from your own machine`);
  if (input.out !== undefined) {
    const why = exportRefusal(input.out);
    if (why) throw new StateExportError(why);
  }
  const location = source.location;
  let version = input.version;
  if (!version) {
    const now = await source.current();
    if (!now.exists) throw new StateExportError(`${location} holds no state`);
    if (!now.versionId) throw new StateExportError(`${location} keeps no versions, so there is no version id to export: ${now.off ?? "the store gave none"}`);
    version = now.versionId;
  } else if (!(await source.hasVersion(version))) {
    throw new StateExportError(`${location} has no version ${version}; a lifecycle rule may have expired it`);
  }
  const versionId = version;
  const result = await gatedOp(
    {
      op: words.op,
      request: { kind: words.kind ?? "state-export", subject: input.subject, by: input.by, fields: { location, version_id: versionId } },
      rules: input.rules,
      description: `state export: ${input.subject} version ${versionId}, for ${input.by}`,
      expiry: input.expiry ?? "48h",
      ...(input.base ? { base: input.base } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.now ? { now: input.now } : {}),
      ...(input.ledger ? { ledger: input.ledger } : {}),
    },
    async ({ approvedBy }) => {
      const name = (words.fileName ?? defaultName)(input.subject, versionId);
      const file = input.out !== undefined ? resolve(input.out) : join(mkdtempSync(join(tmpdir(), words.tmpPrefix ?? "chant-export-")), basename(name));
      // Checked again: the destination may have changed while the request waited.
      const why = exportRefusal(file);
      if (why) throw new StateExportError(why);
      const body = await source.readVersion(versionId);
      if (body === undefined) throw new StateExportError(`${location} has no version ${versionId}; it was deleted since the request`);
      writeFileSync(file, body, { mode: 0o600, flag: "wx" });
      const contentDigest = sha(body);
      return { output: { file, contentDigest }, detail: { by: input.by, location, version_id: versionId, content_digest: contentDigest, approved_by: approvedBy } };
    },
  );
  const command = (digest: string, fallback: string): string => (words.approveCommand ? words.approveCommand(input.subject, digest) : fallback);
  const at = { digest: result.digest, version: versionId, location };
  switch (result.status) {
    case "done":
      return { status: "written", exit: CHANT_EXIT.done, ...at, file: result.output.file, approvedBy: result.approvedBy, contentDigest: result.output.contentDigest, recorded: result.recorded };
    case "waiting":
      return { status: "waiting", exit: CHANT_EXIT.waiting, ...at, command: command(result.digest, result.command) };
    case "refused":
      return { status: "refused", exit: CHANT_EXIT.waiting, ...at, command: command(result.digest, result.command), by: result.by, reason: result.reason };
    case "spent":
      return { status: "spent", exit: CHANT_EXIT.failed, ...at };
    case "held":
      // An export takes no last check, so nothing holds it; kept for the type.
      return { status: "failed", exit: CHANT_EXIT.failed, ...at, error: new StateExportError(result.reason), recorded: false };
    case "failed":
      return { status: "failed", exit: CHANT_EXIT.failed, ...at, error: result.error, recorded: result.recorded };
  }
}
