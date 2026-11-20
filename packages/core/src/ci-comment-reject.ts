/**
 * A rejection from a comment (#5354): `/<product> reject [--stage <stage>]
 * <reason>` on a pull or merge request records a rejection of the release a
 * stage of the pipeline waits on, as `chant reject` does.
 *
 * A comment carries the forge's identity of its author and nothing that
 * proves it further: no seal. So it records only where the stage's approval
 * rules take an approver on that identity, by the rules #5349 sets for the
 * stage's approval mode:
 *
 * - the comment job has already checked the author's permission on the
 *   forge (write access on GitHub and Forgejo, the poll's role on GitLab),
 *   the check the job makes before any command;
 * - `ledger`, `pr-review` and `pull-request` take a plain approval line, so
 *   they take the author's forge identity (`github:<login>`) for a
 *   rejection;
 * - `sealed` counts only a sealed rejection, a gate the workspace's
 *   `identity.gates` names only a signed one from its class, and a rule with
 *   `proven` or `roles` only a proven approver: a comment proves none of
 *   them, so the reply names the reject line to run, and why.
 *
 * The rejection is bound to the digest on the stage gate's standing pending
 * fact, as `chant reject` binds it, with the comment's address as its `url`.
 */

import { latestPendingGate, isPendingGateExpired } from "./lifecycle/gate-ledger";
import type { GateLedgerPort } from "./op/gate";
import { quorumRules, ruleAdmits } from "./op/gate-quorum";
import type { PipelineSpec } from "./pipeline/spec";
import { rejectLine, type CiProductWords } from "./ci-product-words";
import type { GateRejectionOptions } from "./cli/handlers/reject";

/** What a comment job records a rejection with. Absent on a job: a reject comment is answered with the reject line. */
export interface CommentReject {
  /** The pipeline as the default branch has it, whose stages' gates the comment rejects at. */
  pipeline(): Promise<PipelineSpec | undefined>;
  /** The gate ledger on `chant/lifecycle`. */
  port: GateLedgerPort;
  /** The forge principal of a login, such as `github:alice`. */
  principal(login: string): string;
  /** The declaration, trust policy and `identity.gates` rule at base for a gate. Default: read in `cwd`. */
  scope?(gate: string): Promise<NonNullable<GateRejectionOptions["scope"]>>;
  /** The repository the ledger and the trust policy are read in. */
  cwd?: string;
  /** "now", for which pending facts stand. */
  now?: () => string;
}

/** What {@link decideCommentReject} answers: the reply, and whether a rejection was recorded. */
export type CommentRejectOutcome = { kind: "recorded" | "reply"; text: string } | { kind: "fail"; reason: string };

/** Decide a `/<product> reject` comment by `user`, whose permission the job has already checked. */
export async function decideCommentReject(input: {
  reject: CommentReject;
  words: CiProductWords;
  user: string;
  reason: string;
  stage?: string;
  url?: string;
}): Promise<CommentRejectOutcome> {
  const { reject, words } = input;
  let spec: PipelineSpec | undefined;
  try {
    spec = await reject.pipeline();
  } catch (err) {
    return { kind: "fail", reason: `the pipeline at the default branch could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!spec) return { kind: "reply", text: "this repository has no pipeline on its default branch, so no stage waits on a release to reject" };
  const op = spec.name;
  const now = (reject.now ?? (() => new Date().toISOString()))();
  let pending;
  try {
    pending = (await reject.port.read(op)).pending;
  } catch (err) {
    return { kind: "fail", reason: `the gate ledger of ${op} could not be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  const waiting = spec.stages
    .map((s) => ({ stage: s, fact: latestPendingGate(pending.filter((p) => p.environment === undefined || p.environment === s.name), s.name) }))
    .filter((w) => w.fact !== undefined && w.fact.planDigest !== undefined && !isPendingGateExpired(w.fact, now));
  const line = (stage: string, digest: string) => rejectLine(words, { op, gate: stage, digest, reason: "<why>" });
  let chosen: (typeof waiting)[number] | undefined = waiting[0];
  if (input.stage !== undefined) {
    if (!spec.stages.some((s) => s.name === input.stage)) return { kind: "reply", text: `${input.stage} is not a stage of ${op}; its stages are ${spec.stages.map((s) => `\`${s.name}\``).join(", ")}` };
    chosen = waiting.find((w) => w.stage.name === input.stage);
    if (!chosen) return { kind: "reply", text: `no release waits at stage ${input.stage} of ${op}, so there is nothing to reject there` };
  } else if (waiting.length === 0) {
    return { kind: "reply", text: `no release waits at a stage of ${op}, so there is nothing to reject` };
  } else if (waiting.length > 1) {
    return { kind: "reply", text: `releases wait at ${waiting.map((w) => `\`${w.stage.name}\``).join(", ")}: name one with \`/${words.product} ${typedReject(words)} --stage <stage> <reason>\`` };
  }
  const { stage, fact } = chosen!;
  const digest = fact!.planDigest!;
  const mode = stage.gate?.approval ?? "ledger";
  if (mode === "sealed") {
    return { kind: "reply", text: `stage ${stage.name} counts only sealed approvals, so it counts only a sealed rejection, which a comment cannot carry. Run \`${line(stage.name, digest)}\`` };
  }
  const rules = quorumRules(stage.gate?.quorum);
  if (rules.length > 0 && !rules.some((r) => ruleAdmits(r, { proven: false, roles: [] }))) {
    return { kind: "reply", text: `every approval rule of stage ${stage.name} counts only a proven approver, which a comment cannot show, so it counts only a sealed rejection. Run \`${line(stage.name, digest)}\`` };
  }
  const { recordGateRejection, scopeAt } = await import("./cli/handlers/reject");
  const scope = reject.scope ? await reject.scope(stage.name) : await scopeAt(reject.cwd ?? process.cwd(), stage.name);
  if (scope.rule) {
    return { kind: "reply", text: `the workspace's identity.gates names gate ${stage.name}, so it counts only a signed rejection, which a comment cannot carry. Run \`${line(stage.name, digest)}\`` };
  }
  const who = reject.principal(input.user);
  const out = await recordGateRejection(op, stage.name, {
    reason: input.reason,
    actor: who,
    plan: digest,
    ...(fact!.environment !== undefined ? { environment: fact!.environment } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    origin: "cli",
    port: reject.port,
    scope,
    ...(reject.cwd !== undefined ? { cwd: reject.cwd } : {}),
  });
  if ("statement" in out) return { kind: "fail", reason: "the rejection was not recorded" };
  if (!out.ok) return { kind: "reply", text: out.message };
  const pushed = out.pushed ? "" : " The ledger push did not land, so other jobs do not see it yet.";
  return { kind: "recorded", text: `recorded ${who}'s rejection of ${digest} at ${op} ${stage.name}: ${input.reason}. It does not enter ${stage.name}, and more approvals do not clear it; a new release goes through again.${pushed}` };
}

function typedReject(words: CiProductWords): string {
  return Object.entries(words.commands).find(([, c]) => c === "reject")?.[0] ?? "reject";
}

/** The variable naming the member directory whose `.chant/pipeline.ts` a reject comment reads (#5354). Default: the job's directory. */
export const COMMENT_REJECT_DIR_ENV = "CHANT_PIPELINE_DIR";

/**
 * What a comment job records a reject comment with (#5354), when the
 * product's words map a comment command onto `reject`; undefined
 * otherwise, and the reply names the reject line. The pipeline is folded as
 * the default branch has it, the ledger is this checkout's
 * `chant/lifecycle`, and the author is named by their forge principal.
 */
export async function commentRejectFromEnv(words: CiProductWords, env: Record<string, string | undefined> = process.env, cwd: string = process.cwd()): Promise<CommentReject | undefined> {
  if (!Object.values(words.commands).includes("reject")) return undefined;
  const { resolve } = await import("node:path");
  const dir = resolve(cwd, env[COMMENT_REJECT_DIR_ENV] ?? ".");
  const { gitGateLedgerPort } = await import("./op/gate");
  const { forgePrincipalFromEnv } = await import("./op/gate-review");
  return {
    async pipeline() {
      const { promoteBase, readPipelineAt } = await import("./pipeline/read");
      const base = promoteBase(dir);
      if (!base) return undefined;
      const read = readPipelineAt(base, dir);
      if (read.status === "refused") throw new Error(read.line);
      return read.status === "folded" ? read.spec : undefined;
    },
    port: gitGateLedgerPort({ cwd: dir }),
    principal: forgePrincipalFromEnv(env),
    cwd: dir,
  };
}
