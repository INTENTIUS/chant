/**
 * `chant workspace signers [rotate [--threshold <n>] | sign --key <file>]`
 * (#2553): show the signer history, and propose a new signer set.
 *
 * Rotating is three steps: edit the signers file, run `rotate` to write the
 * rotation file for the next version, and have a threshold of the current
 * signers each run `sign` with their own key. `chant workspace verify` then
 * checks the result against the set at base.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatError, formatSuccess } from "../../cli/format";
import type { CommandContext } from "../../cli/registry";
import { readerVersion } from "../declaration";
import type { ReasonCode } from "../reason-codes";
import { gitRoot } from "../record-source";
import { parseAllowedSigners, readTrustPolicy } from "./policy";
import { resolveBase } from "./provenance";
import { gitRevisionSource } from "../record-source";
import {
  distinctHolders,
  rotationFileSchema,
  rotationPath,
  rotationStatement,
  ROTATION_NAMESPACE,
  signerHistory,
  signersDigest,
  type RotationFile,
  type RotationRefusalCode,
  type SignerHistory,
} from "./rotation";
import { verifySshSignature } from "./ssh-commit";

const USAGE = "chant workspace signers [--base <rev>] [--json] | signers rotate [--threshold <n>] | signers sign --key <ssh private key>";

export const SIGNERS_CONTRACT_VERSION = 1;
export const SIGNERS_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/signers/v1/signers.schema.json";

/** Why `chant workspace signers` prints no history. Each is in `reason-codes.ts` and `signers.schema.json`. */
export const SIGNERS_ERROR_CODES = ["not-a-git-repository", "revision-unknown", "signers-file-missing"] as const satisfies readonly ReasonCode[];
export type SignersErrorCode = (typeof SIGNERS_ERROR_CODES)[number];

/** What `chant workspace signers --json` prints. */
export type SignersDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      base: string;
      signersPath: string;
      versions: Array<{ version: number; commit: string | null; digest: string | null; threshold: number; principals: string[]; signedBy: string[] }>;
      broken: { commit: string | null; code: RotationRefusalCode; message: string } | null;
    }
  | { $schema: string; contract: number; chant: string; error: { code: SignersErrorCode; message: string } };

function head() {
  return { $schema: SIGNERS_OUTPUT_SCHEMA_ID, contract: SIGNERS_CONTRACT_VERSION, chant: readerVersion() };
}

/** The signer history at `base` as the `--json` document. */
export function signersDocument(repo: string, base: string, signersPath: string, history: SignerHistory): SignersDocument {
  return {
    ...head(),
    base,
    signersPath,
    versions: history.versions.map((v) => ({
      version: v.version,
      commit: v.commit,
      digest: v.version === 0 ? null : v.digest,
      threshold: v.threshold,
      principals: [...new Set(v.signers.map((s) => s.principal))].sort(),
      signedBy: v.signedBy,
    })),
    broken: history.broken ? { commit: history.broken.commit, code: history.broken.code, message: history.broken.reason } : null,
  };
}

function fail(message: string): number {
  console.error(formatError({ message, hint: USAGE }));
  return 1;
}

export async function runWorkspaceSigners(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const sub = args.extraPositional;
  const refuse = (code: SignersErrorCode, message: string): number => {
    if (args.json && !sub) console.log(JSON.stringify({ ...head(), error: { code, message } }, null, 2));
    else console.error(formatError({ message, hint: USAGE }));
    return 1;
  };
  const repo = gitRoot(process.cwd());
  if (!repo) return refuse("not-a-git-repository", "signer history is read from git, and this directory is not in a git repository");
  const base = resolveBase(repo, args.base);
  if (!base.commit) return refuse("revision-unknown", base.problem ?? "no base revision");
  // The policy as written at base; its history is checked below, not taken on trust.
  const policy = readTrustPolicy(gitRevisionSource(repo, base.commit), base.commit);
  if (!policy.active) return refuse("signers-file-missing", `there is no signers file (${policy.signersPath}) at base ${base.commit.slice(0, 8)}`);
  const history = signerHistory(repo, base.commit, policy.signersPath);
  const latest = history.versions.at(-1);

  if (!sub) {
    if (args.json) {
      console.log(JSON.stringify(signersDocument(repo, base.commit, policy.signersPath, history), null, 2));
      return history.broken ? 1 : 0;
    }
    for (const v of history.versions) {
      if (v.version === 0) {
        console.log(`  ${v.commit?.slice(0, 8)}  signers file removed`);
        continue;
      }
      const by = v.signedBy.length ? `, signed by ${v.signedBy.join(", ")}` : ", the first version";
      console.log(`  ${v.commit?.slice(0, 8)}  version ${v.version}: ${new Set(v.signers.map((s) => s.principal)).size} signers, threshold ${v.threshold}${by}`);
    }
    if (history.broken) return fail(`the history breaks at ${history.broken.commit?.slice(0, 8)} (${history.broken.code}): ${history.broken.reason}`);
    return 0;
  }
  if (history.broken || !latest || latest.version === 0) return fail("the signer history at base is not valid, so there is no version to rotate from");

  const signersFile = join(repo, policy.signersPath);
  const rotationFile = join(repo, rotationPath(policy.signersPath));
  const text = readFileSync(signersFile, "utf-8");

  if (sub === "rotate") {
    const threshold = args.threshold !== undefined ? Number(args.threshold) : latest.threshold;
    if (!Number.isInteger(threshold) || threshold < 1) return fail("--threshold takes a whole number of at least 1");
    const holders = distinctHolders(parseAllowedSigners(text).signers);
    if (threshold > holders) return fail(`--threshold ${threshold} is more than the ${holders} distinct signers in the new set`);
    const rotation: RotationFile = { schema: 1, version: latest.version + 1, previous: latest.digest, threshold, signatures: [] };
    writeFileSync(rotationFile, JSON.stringify(rotation, null, 2) + "\n");
    console.log(
      formatSuccess(
        `wrote ${rotationPath(policy.signersPath)} for version ${rotation.version}; ${latest.threshold} of the version ${latest.version} signers must now run chant workspace signers sign --key <their key>`,
      ),
    );
    return 0;
  }

  if (sub === "sign") {
    if (!args.key) return fail("--key <ssh private key> is required");
    if (!existsSync(rotationFile)) return fail(`there is no ${rotationPath(policy.signersPath)}; run chant workspace signers rotate first`);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(rotationFile, "utf-8"));
    } catch {
      return fail(`${rotationPath(policy.signersPath)} is not JSON`);
    }
    const parsed = rotationFileSchema.safeParse(raw);
    if (!parsed.success) return fail(`${rotationPath(policy.signersPath)} is invalid`);
    if (parsed.data.version !== latest.version + 1 || parsed.data.previous !== latest.digest) {
      return fail(`${rotationPath(policy.signersPath)} is not the next version after version ${latest.version} at base; run chant workspace signers rotate again`);
    }
    const rotation = parsed.data;
    const statement = rotationStatement(rotation, signersDigest(text));
    let pub: string;
    try {
      pub = execFileSync("ssh-keygen", ["-y", "-f", args.key], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim().split(/\s+/).slice(0, 2).join(" ");
    } catch (err) {
      return fail(`ssh-keygen could not read ${args.key}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
    const me = latest.signers.find((s) => s.key === pub);
    if (!me) return fail(`this key is not in version ${latest.version} of the signer set, so its signature would not count`);
    let sig: string;
    try {
      sig = execFileSync("ssh-keygen", ["-q", "-Y", "sign", "-n", ROTATION_NAMESPACE, "-f", args.key], { input: statement, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      return fail(`ssh-keygen could not sign with ${args.key}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
    const check = verifySshSignature([me], statement, sig, ROTATION_NAMESPACE);
    if (!check.ok) return fail(`the signature did not verify: ${check.reason}`);
    rotation.signatures = [...rotation.signatures.filter((s) => s.principal !== me.principal), { principal: me.principal, signature: sig }];
    writeFileSync(rotationFile, JSON.stringify(rotation, null, 2) + "\n");
    console.log(formatSuccess(`signed version ${rotation.version} as ${me.principal} (${rotation.signatures.length} of ${latest.threshold} needed)`));
    return 0;
  }
  return fail(`Unknown signers subcommand: ${sub}`);
}
