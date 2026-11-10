/**
 * `@intentius/chant/ref-gate-init` (#4913): the pieces of the ref gate a
 * product's init writes, so no product writes `.chant/trust.json`, a hook or
 * its own runner key words.
 *
 * {@link refGateInitPlan} plans, and writes nothing, so a product folds the
 * files into its own plan and keeps its dry run:
 *
 * - `.chant/trust.json` with a `refs` rule for the branch (#4867): created
 *   with `"schema": 1` when there is none, the rule added in place when the
 *   file has no rule for the branch, left as it is when it has one or does
 *   not parse.
 * - The `pre-push` hook `chant workspace ref-gate install` writes, in the
 *   checkout's hooks directory, so a push the gate would refuse stops before
 *   the network and records the request for an override. It is local: git
 *   never commits it. A hook that is not chant's is left as it is.
 * - The runner key hint: with no runner key and no keyless identity in the
 *   file, nothing can sign the evidence the rule needs, so the gate would
 *   refuse every push; a note gives the commands that list a key and where
 *   the pipeline reads it.
 *
 * {@link writeRefGateInit} writes the planned files, the hook executable.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { writePlannedFiles } from "./planned-files";
import { appendElement, setProperty } from "./workspace/json-edit";
import { parseJsonText } from "./workspace/jsonc";
import { REF_CHECK_NAME, TRUST_CONFIG_PATH, trustConfigSchema, type TrustConfig } from "./workspace/trust/policy";
import { refPatternRegExp, REF_GATE_STATUS } from "./workspace/trust/ref-gate";
import { REF_GATE_HOOK_MARK, refGateHook } from "./workspace/trust/ref-gate-cli";

export { REF_GATE_PIECES_FLOOR } from "./release-floors";

/** One check the rule requires evidence for, as `refs[].checks[]` holds it. */
export interface RefGateInitCheck {
  check: string;
  /** Default `block`. */
  action?: "block" | "warn";
  /** The command that produces the evidence, printed in a refusal. */
  command: string;
}

export interface RefGateInitOptions {
  /** The branch the gate protects. Default `main`. */
  branch?: string;
  /** The checks an update of the branch needs current evidence for. At least one. */
  checks: readonly RefGateInitCheck[];
  /** The commit status the gate's status job sets. Default `chant/ref-gate`, which the rule then leaves out. */
  status?: string;
  /** Write the `pre-push` hook in this checkout. Default true. */
  prePush?: boolean;
  /** The command the hook runs for chant, such as `npx chant`. Default `chant`. */
  chant?: string;
  /** For the hint: the principal the runner key is listed under, such as `ci:acme/infra`. */
  runner?: string;
  /** For the hint: the secret or CI/CD variable the pipeline reads the runner key from (`evidence.runnerKeySecret`, `--evidence-runner-key-secret`). */
  runnerKeySecret?: string;
}

/** A planned file, in the shape a product's init plans its own. */
export interface RefGateInitFile {
  /** Absolute. */
  path: string;
  status: "created" | "updated" | "unchanged";
  content: string;
  /** The hook's mode, 0o755; a product that writes the file itself sets it. */
  mode?: number;
  /** In the git directory, so never committed. */
  local?: boolean;
}

export interface RefGateInitPlan {
  files: RefGateInitFile[];
  /** What a person still has to do, or what was left as it is and why. */
  notes: string[];
}

export class RefGateInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefGateInitError";
  }
}

function gitOut(repo: string, args: string[]): string | undefined {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

function planned(path: string, content: string, extra: Pick<RefGateInitFile, "mode" | "local"> = {}): RefGateInitFile {
  const before = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
  return { path, status: before === undefined ? "created" : before === content ? "unchanged" : "updated", content, ...extra };
}

/** The `refs` rule for `ref`, with `action` and `status` only where they differ from the defaults. */
function ruleFor(ref: string, opts: RefGateInitOptions): Record<string, unknown> {
  return {
    ref,
    checks: opts.checks.map((c) => ({ check: c.check, ...(c.action === "warn" ? { action: "warn" } : {}), command: c.command })),
    ...(opts.status && opts.status !== REF_GATE_STATUS ? { status: opts.status } : {}),
  };
}

/**
 * Plan the ref gate's init pieces for the checkout `repo` (#4913). Writes
 * nothing. Throws a {@link RefGateInitError} for options no rule can hold,
 * or a directory that is not in a git repository.
 */
export function refGateInitPlan(repo: string, opts: RefGateInitOptions): RefGateInitPlan {
  const branch = opts.branch ?? "main";
  const ref = `refs/heads/${branch}`;
  if (!branch || /\s|\*/.test(branch)) throw new RefGateInitError(`the branch is one branch name, such as main, not ${JSON.stringify(branch)}`);
  if (opts.checks.length === 0) throw new RefGateInitError("the ref gate's rule needs at least one check");
  for (const c of opts.checks) {
    if (!REF_CHECK_NAME.test(c.check)) throw new RefGateInitError(`${JSON.stringify(c.check)} is not a check name: letters, digits, . _ : -`);
    if (!c.command.trim()) throw new RefGateInitError(`check ${c.check} needs the command that produces its evidence`);
  }
  const top = gitOut(repo, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new RefGateInitError(`${repo} is not in a git checkout; the ref gate's pieces go in one`);

  const files: RefGateInitFile[] = [];
  const notes: string[] = [];
  const trustPath = join(top, TRUST_CONFIG_PATH);
  const rule = ruleFor(ref, opts);
  let config: TrustConfig | undefined;
  if (!existsSync(trustPath)) {
    config = { schema: 1, refs: [rule as NonNullable<TrustConfig["refs"]>[number]] };
    files.push(planned(trustPath, `${JSON.stringify(config, null, 2)}\n`));
  } else {
    const before = readFileSync(trustPath, "utf-8");
    const parsed = parseJsonText(before, { jsonc: false });
    const valid = parsed.ok ? trustConfigSchema.safeParse(parsed.value) : undefined;
    if (!parsed.ok || !valid?.success) {
      notes.push(`${TRUST_CONFIG_PATH} does not read as chant's trust policy, so init left it as it is; add a refs rule for ${ref} by hand once it does (chant workspace ref-gate)`);
    } else {
      config = valid.data;
      const covering = (config.refs ?? []).find((r) => refPatternRegExp(r.ref).test(ref));
      if (covering) {
        notes.push(`${TRUST_CONFIG_PATH} already has a refs rule for ${ref} (${covering.ref}), so init left it as it is`);
        files.push(planned(trustPath, before));
      } else {
        const after = config.refs ? appendElement(before, false, "/refs", rule) : setProperty(before, false, "", "refs", [rule]);
        // The in-place edit is checked against the value it means, as the trust writes check theirs.
        const reread = parseJsonText(after, { jsonc: false });
        const check = reread.ok ? trustConfigSchema.safeParse(reread.value) : undefined;
        if (!check?.success || (check.data.refs ?? []).length !== (config.refs ?? []).length + 1) throw new RefGateInitError(`adding the refs rule to ${TRUST_CONFIG_PATH} did not read back as meant`);
        config = check.data;
        files.push(planned(trustPath, after));
      }
    }
  }
  if (files.some((f) => f.path === trustPath && f.status !== "unchanged")) {
    notes.push(`${TRUST_CONFIG_PATH} is a protected write: merge it in a reviewed pull request; the gate reads it at base, so it holds from the next change on`);
  }

  if (config && (config.runners ?? []).length === 0 && !config.keyless) {
    const principal = opts.runner ?? "<runner principal>";
    const secret = opts.runnerKeySecret ?? "<secret>";
    notes.push(
      `no runner key or keyless identity is in ${TRUST_CONFIG_PATH}, so no evidence verifies and the gate refuses every push to ${ref}. ` +
        `Make a key with \`openssl genpkey -algorithm ed25519 -out runner.pem\`, list it with \`chant workspace trust runner add ${principal} --key runner.pem\`, ` +
        `and keep runner.pem out of the repository: store it in the ${secret} secret the pipeline signs evidence with. Or list the pipeline's OIDC identity under keyless and sign with no key.`,
    );
  }

  if (opts.prePush !== false) {
    const hooks = gitOut(top, ["rev-parse", "--git-path", "hooks"]);
    const dir = hooks ? (isAbsolute(hooks) ? hooks : join(top, hooks)) : join(top, ".git", "hooks");
    const path = join(dir, "pre-push");
    if (existsSync(path) && !readFileSync(path, "utf-8").includes(REF_GATE_HOOK_MARK)) {
      notes.push(`${path} is not chant's ref gate hook, so init left it as it is; call ${opts.chant ?? "chant"} workspace ref-gate pre-push from it`);
    } else {
      files.push(planned(path, refGateHook("pre-push", opts.chant), { mode: 0o755, local: true }));
    }
  }
  return { files, notes };
}

/** Write the files of a plan, each directory made and the hook executable. An unchanged file is not touched. */
export function writeRefGateInit(plan: Pick<RefGateInitPlan, "files">): void {
  // #4966: chant's one planned-file writer.
  writePlannedFiles(plan.files);
}
