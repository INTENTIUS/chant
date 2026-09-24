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
import { gitRoot } from "../record-source";
import { parseAllowedSigners } from "./policy";
import { policyAtBase, resolveBase } from "./provenance";
import { rotationFileSchema, rotationPath, rotationStatement, ROTATION_NAMESPACE, signerHistory, signersDigest, type RotationFile } from "./rotation";
import { verifySshSignature } from "./ssh-commit";

const USAGE = "chant workspace signers [--base <rev>] | signers rotate [--threshold <n>] | signers sign --key <ssh private key>";

function fail(message: string): number {
  console.error(formatError({ message, hint: USAGE }));
  return 1;
}

export async function runWorkspaceSigners(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const repo = gitRoot(process.cwd());
  if (!repo) return fail("signer history is read from git, and this directory is not in a git repository");
  const base = resolveBase(repo, args.base);
  if (!base.commit) return fail(base.problem ?? "no base revision");
  const policy = policyAtBase(repo, base);
  if (!policy.active) return fail(`there is no signers file (${policy.signersPath}) at base ${base.commit.slice(0, 8)}`);
  const history = signerHistory(repo, base.commit, policy.signersPath);
  const latest = history.versions.at(-1);
  const sub = args.extraPositional;

  if (!sub) {
    for (const v of history.versions) {
      if (v.version === 0) {
        console.log(`  ${v.commit?.slice(0, 8)}  signers file removed`);
        continue;
      }
      const by = v.signedBy.length ? `, signed by ${v.signedBy.join(", ")}` : ", the first version";
      console.log(`  ${v.commit?.slice(0, 8)}  version ${v.version}: ${new Set(v.signers.map((s) => s.principal)).size} signers, threshold ${v.threshold}${by}`);
    }
    if (history.broken) return fail(`the history breaks at ${history.broken.commit?.slice(0, 8)}: ${history.broken.reason}`);
    return 0;
  }
  if (history.broken || !latest || latest.version === 0) return fail("the signer history at base is not valid, so there is no version to rotate from");

  const signersFile = join(repo, policy.signersPath);
  const rotationFile = join(repo, rotationPath(policy.signersPath));
  const text = readFileSync(signersFile, "utf-8");

  if (sub === "rotate") {
    const threshold = args.threshold !== undefined ? Number(args.threshold) : latest.threshold;
    if (!Number.isInteger(threshold) || threshold < 1) return fail("--threshold takes a whole number of at least 1");
    const signers = parseAllowedSigners(text).signers;
    if (threshold > new Set(signers.map((s) => s.key)).size) return fail(`--threshold ${threshold} is more than the ${signers.length} keys in the new set`);
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
    const parsed = rotationFileSchema.safeParse(JSON.parse(readFileSync(rotationFile, "utf-8")));
    if (!parsed.success) return fail(`${rotationPath(policy.signersPath)} is invalid`);
    const rotation = parsed.data;
    const statement = rotationStatement(rotation, signersDigest(text));
    const pub = execFileSync("ssh-keygen", ["-y", "-f", args.key], { encoding: "utf-8" }).trim().split(/\s+/).slice(0, 2).join(" ");
    const me = latest.signers.find((s) => s.key === pub);
    if (!me) return fail(`this key is not in version ${latest.version} of the signer set, so its signature would not count`);
    const sig = execFileSync("ssh-keygen", ["-q", "-Y", "sign", "-n", ROTATION_NAMESPACE, "-f", args.key], { input: statement, encoding: "utf-8" });
    const check = verifySshSignature([me], statement, sig, ROTATION_NAMESPACE);
    if (!check.ok) return fail(`the signature did not verify: ${check.reason}`);
    rotation.signatures = [...rotation.signatures.filter((s) => s.principal !== me.principal), { principal: me.principal, signature: sig }];
    writeFileSync(rotationFile, JSON.stringify(rotation, null, 2) + "\n");
    console.log(formatSuccess(`signed version ${rotation.version} as ${me.principal} (${rotation.signatures.length} of ${latest.threshold} needed)`));
    return 0;
  }
  return fail(`Unknown signers subcommand: ${sub}`);
}
