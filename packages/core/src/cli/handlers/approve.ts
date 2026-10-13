/**
 * `chant approve` (#1485) and the ledger write behind it. Split out of
 * `./operator.ts` (#3896) so the slim wave-job runtime bundles the approval
 * without the operator loop, the build or the lint machinery; `./operator.ts`
 * re-exports everything here.
 */
import { discoverOps } from "../../op/discover";
import { aliasingGate } from "../../op/gate-alias";
import type { GateResolutionRecord, PendingGateRecord } from "../../lifecycle/gate-ledger";
import {
  currentGateOrigin, isModelAuthored, sameOriginRefusal, UNATTESTED_APPROVER, type GateOrigin,
} from "../../lifecycle/gate-origin";
import {
  appendGateResolution, appendPendingGate, readGateLedger,
  latestPendingGate, isPendingGateExpired,
  resolveApprovalUrl, isApprovalUrl,
} from "../../lifecycle/gate-ledger";
import { isPlanDigest, samePlanDigest } from "../../lifecycle/plan-digest";
import {
  gateContextDigest, gatePolicyRequest, loadGatePolicyEvaluator,
  type GateApprover, type GatePolicyDecision, type GatePolicyEvaluator, type ResolvedGateApproval,
} from "../../op/gate-approval";
import { approverOf, humanQuorumSince, tallyGateApprovals } from "../../op/gate";
import { FAN_OUT_GATE_OP, OVERRIDE_GATE_OP, WORKSPACE_UPGRADE_GATE_OP } from "../../op/gate-name";
import { PR_GATE_OP } from "../../pr-loop";
import { pushLifecycleReport, requireLifecycleLedger } from "../../lifecycle/git";
import { LIFECYCLE_LOCAL_NOTE, isLifecycleLocalNote } from "../../lifecycle/local-note";
import { ledgerRecordingOff, NO_RECORD_ENV } from "../../lifecycle/no-record";
import { formatError, formatWarning, formatSuccess, formatInfo } from "../format";
import type { CommandContext } from "../registry";

// ── chant approve <op> <gate> ───────────────────────────────────────────────

/**
 * `chant approve <op> <gate> [--actor <name>] [--note <text>] [--url <url>]
 * [--expire]` — record the out-of-band resolution fact for a gate a run
 * stopped at (issue #1485: "resolution is an out-of-band act that writes the
 * counterpart fact"). Per that issue's leaning on open question 3 ("local
 * trust in v1"), this performs no authorization check beyond "you can run
 * `chant approve` locally".
 *
 * Since #2119 this closes the loop rather than just narrating it: the next
 * `chant run <op>` reads the resolution, finds it newer than the gate's
 * pending fact, and walks through.
 *
 * `--expire` is the other half — clear a standing pending fact *without*
 * approving anything, for a gate that was recorded against a run nobody
 * intends to finish. It writes no resolution; it appends a pending fact that
 * is already expired, which supersedes the standing one on an append-only
 * ledger, so the next run decides the gate from scratch.
 */
/** The ledger branch, named in the warnings below so a reader can go look at it. */
const LIFECYCLE_BRANCH = "chant/lifecycle";

/**
 * Push the ledger and say so when it does not land (#2309 review, refs #2310).
 *
 * Both write paths here used `pushLifecycle().catch(() => undefined)` and then
 * printed unconditional success and exited 0. A rejected push — a stale lease,
 * no credentials, no network — therefore read as a completed approval, which
 * is the one thing an approval must never do: the operator walks away
 * believing the gate is answered for everybody, while the resolution exists
 * only in their own checkout.
 *
 * The append is still a correct *local* fact, so this is a warning and not a
 * failure; the exit code is unchanged. With no remote at all there is nobody
 * elsewhere to tell, so that case is a quiet suffix and no warning (#3677).
 */
async function reportedPush(consequence: string): Promise<{ pushed: boolean; suffix: string }> {
  const { pushed, pushWarning } = await pushLifecycleReport();
  if (pushed) return { pushed, suffix: "" };
  if (isLifecycleLocalNote(pushWarning)) return { pushed, suffix: ` (${LIFECYCLE_LOCAL_NOTE})` };
  console.error(formatWarning({
    message: `The push to the remote did not land: ${pushWarning ?? "no reason given"}`,
    hint: consequence,
  }));
  return { pushed, suffix: " (local only — the push did not land)" };
}

export async function runApprove(ctx: CommandContext): Promise<number> {
  const opName = ctx.args.path;
  const gate = ctx.args.extraPositional;
  if (!opName || opName === "." || !gate) {
    console.error(formatError({ message: "Usage: chant approve <op> <gate>" }));
    return 1;
  }

  if (ctx.args.expire) {
    // Same guard as the approve path below (#2303): `--expire` reads the
    // standing fact and appends beside it, so a clone that never fetched the
    // branch would both fail to see the fact it is expiring and replace the
    // branch with the expiry alone.
    try {
      await requireLifecycleLedger();
    } catch (err) {
      console.error(formatError({
        message: `Cannot expire the gate: ${err instanceof Error ? err.message : String(err)}`,
      }));
      return 1;
    }
    const now = new Date().toISOString();
    const standing = latestPendingGate((await readGateLedger(opName)).pending, gate);
    if (!standing || isPendingGateExpired(standing, now)) {
      console.error(formatWarning({
        message: `Gate "${gate}" on "${opName}" has no standing pending fact — nothing to expire`,
      }));
      return 0;
    }
    await appendPendingGate({
      op: opName,
      gate,
      timestamp: now,
      expiresAt: now,
      ...(standing.description ? { description: standing.description } : {}),
    });
    const push = await reportedPush(
      `The expiry is recorded locally on ${LIFECYCLE_BRANCH}. Until it reaches the remote, ` +
        `a run in another checkout still sees the old pending fact.`,
    );
    console.error(formatSuccess(
      `Gate "${gate}" on "${opName}" expired at ${now} — not approved` + push.suffix,
    ));
    console.error(formatInfo(
      opName === FAN_OUT_GATE_OP
        ? `The next \`chant components fan-out\` decides this gate from scratch and records a fresh pending fact.`
        : PR_GATE_OP.test(opName)
          ? `The next \`chant components pr-apply\` decides this gate from scratch and records a fresh pending fact.`
          : opName === WORKSPACE_UPGRADE_GATE_OP
          ? `The next \`chant workspace upgrade ${gate}\` decides this gate from scratch and records a fresh pending fact.`
          : `The next \`chant run ${opName}\` decides this gate from scratch and records a fresh pending fact.`,
    ));
    return 0;
  }

  // #3760: an override of a denied plan names its rules and gives a reason.
  if (opName === OVERRIDE_GATE_OP) {
    const { runOverrideApprove } = await import("./override-approve");
    return runOverrideApprove(ctx);
  }
  if (ctx.args.rules !== undefined || ctx.args.reason !== undefined) {
    console.error(formatError({
      message: `--rule and --reason override a denied plan: chant approve ${OVERRIDE_GATE_OP} <subject> --rule <id> --reason <text>`,
      hint: `To approve gate "${gate}" on "${opName}", put any prose in --note.`,
    }));
    return 1;
  }

  // `--approver` wins over `--actor`, the same precedence `chant run approve`
  // has applied since #2126 (`../handlers/run.ts`'s `runOpApprove`). Reading
  // only `--actor` here meant every README that teaches `--approver you`
  // recorded the shell user instead (#2192).
  const outcome = await recordGateApproval(opName, gate, {
    actor: ctx.args.approver ?? ctx.args.actor,
    note: ctx.args.note,
    url: ctx.args.url,
    plan: ctx.args.plan,
    ...(ctx.args.env !== undefined ? { environment: ctx.args.env } : {}),
    allowSameOrigin: ctx.args.allowSameOrigin,
    ...(ctx.args.roles ? { roles: ctx.args.roles } : {}),
    ...(ctx.args.agent ? { agent: true } : {}),
    ...(ctx.args.sign !== undefined ? { sign: ctx.args.sign } : {}),
    ...(ctx.args.relayedBy !== undefined ? { relayedBy: ctx.args.relayedBy } : {}),
  });
  if (!outcome.ok) return 1;

  // #3683: start the CI job that waits at this gate again.
  if (ctx.args.resumeRun || ctx.args.resume !== undefined) {
    const { resumeAfterApproval } = await import("./gate-resume");
    return resumeAfterApproval(opName, gate, outcome.record.environment, outcome.pushed);
  }

  console.error(formatInfo(
    `This records the resolution as a fact; it does not itself re-run anything. ` +
      (opName === FAN_OUT_GATE_OP
        ? `Repeat the \`chant components fan-out\` command and it walks through gate "${gate}".`
        : PR_GATE_OP.test(opName)
          ? `The pull request's apply (\`chant components pr-apply\`) walks through gate "${gate}" when it plans this same digest.`
          : opName === WORKSPACE_UPGRADE_GATE_OP
          ? `Repeat \`chant workspace upgrade ${gate}\` with the same target, and it applies the patch this approval names.`
          : `Run \`chant run ${opName}\` and it walks through gate "${gate}".`),
  ));
  return 0;
}

/** What a caller supplies alongside the op and gate names. */
export interface GateApprovalOptions {
  /**
   * The channel this resolution arrived on (chant#2384). Defaults to the
   * process's own — `"cli"` unless an entry point declared otherwise — and is
   * a parameter only so a caller that knows better can say so.
   */
  origin?: GateOrigin;
  /**
   * Record a resolution that the same-origin rule would refuse (chant#2384).
   *
   * There is a legitimate case: a single operator driving an agent, who wants
   * the model's run resolved from the same session and accepts what that
   * means. The override exists so that is a deliberate act with a trace on the
   * record, rather than the default.
   */
  allowSameOrigin?: boolean;
  /** `--actor`/`--approver`; falls back to the CI or shell identity. */
  actor?: string;
  /** `--note` — free-text prose. */
  note?: string;
  /**
   * `--relayed-by <principal>` (#3402): who carried this approval to chant for
   * the approver, such as a follower program relaying a person's approval.
   * Recorded as `relayedBy` on the resolution line and covered by `--sign`.
   * The approver is still `--actor`; the relay is not an approver.
   */
  relayedBy?: string;
  /** `--url` — the approval surface, validated as absolute http/https. */
  url?: string;
  /**
   * `--plan <digest>` (#2300) — the plan this approval is for. Omitted, the
   * digest is read off the gate's standing pending fact, so the common path
   * stays one command: run, read what it planned, approve it.
   */
  plan?: string;
  /**
   * `--env <env>` (#2574) — which environment's pending fact a component gate
   * approval answers. A component's gate ledger holds every environment's
   * facts, so without it the newest one is approved. Ignored for a gate whose
   * pending facts record no environment (every Op gate).
   */
  environment?: string;
  /** `--role` (#2508) — roles the approver claims. */
  roles?: string[];
  /**
   * `--agent` (#2508) — record this as an agent's approval. On a
   * model-authored channel it is one whether or not this is set.
   */
  agent?: boolean;
  /**
   * `--sign [<key file>]` (#3163, ws-080): seal the approval with an ssh key,
   * a key file or true for git's `user.signingkey`. The seal attests the
   * approver when the signers file at base lists the key for them, and a gate
   * the declaration's `identity.gates` names counts only sealed approvals.
   */
  sign?: string | true;
  /** Where the workspace and the key file are looked up from. Defaults to the process's directory. */
  cwd?: string;
  /** Replaces the lexicon evaluator a gate policy is loaded from. For tests. */
  evaluator?: GatePolicyEvaluator;
}

export type GateApprovalOutcome =
  | { ok: true; record: GateResolutionRecord; pushed: boolean }
  | { ok: false };

/**
 * The ledger write behind `chant approve` — extracted so `chant run approve`
 * (#2121) records the identical fact before waking the runtime that hosts the
 * gated run, instead of growing a second, drifting writer.
 *
 * Prints the same warning for an undiscovered op and the same success line as
 * `chant approve` always did; the caller adds whatever it does next.
 *
 * Since #2300 the resolution names the plan it approves. By default that is
 * the standing pending fact's plan — the one the gated run produced — so the
 * common path is still `chant run`, read, `chant approve`. With no pending
 * fact and no `--plan`, this refuses: there is nothing on the ledger saying
 * what would be approved, and writing a resolution anyway is what made an
 * approval mean "the next run" instead of "this plan".
 */
export async function recordGateApproval(
  opName: string,
  gate: string,
  opts: GateApprovalOptions,
): Promise<GateApprovalOutcome> {
  // #3955: with recording off the approval would be dropped with the process.
  if (ledgerRecordingOff()) {
    console.error(formatError({
      message: `Cannot record the approval of "${gate}": ${NO_RECORD_ENV} is set, so nothing is written to chant/lifecycle`,
      hint: `Unset ${NO_RECORD_ENV} to approve the gate.`,
    }));
    return { ok: false };
  }
  const { ops } = await discoverOps();
  // `fan-out` is the op name every `chant components fan-out` gate is recorded
  // under (../handlers/fan-out.ts). It is a command rather than a declaration,
  // so there is no `*.op.ts` to find and nothing is wrong when none is there.
  // #3949: a gate that lists this one as an alias, after an Op was restructured.
  const successor = aliasingGate([...ops.values()].map((o) => o.config), opName, gate);
  if (!successor && !ops.has(opName) && opName !== FAN_OUT_GATE_OP && opName !== WORKSPACE_UPGRADE_GATE_OP && opName !== OVERRIDE_GATE_OP) {
    console.error(formatWarning({
      message: `Op "${opName}" was not found among discovered *.op.ts declarations — recording the resolution anyway`,
    }));
  }

  // Read the branch before appending to it (#2303 finding 2). Without this,
  // an approve in a clone that never fetched `chant/lifecycle` builds its
  // commit from an empty tree with no parent and replaces the branch with a
  // single commit holding only this resolution — the pending fact it is
  // answering is discarded rather than appended to.
  try {
    await requireLifecycleLedger();
  } catch (err) {
    console.error(formatError({
      message: `Cannot record the approval: ${err instanceof Error ? err.message : String(err)}`,
      hint: "The pending fact this answers lives on that branch; appending without it would drop it.",
    }));
    return { ok: false };
  }

  // #3949: an approval under an alias counts toward the new gate only while
  // the new gate has no standing fact of its own. Once it has one, approve
  // the gate the runs now stop at.
  if (successor) {
    const theirs = latestPendingGate((await readGateLedger(successor.op)).pending, successor.gate);
    if (theirs && !isPendingGateExpired(theirs, new Date().toISOString())) {
      console.error(formatError({
        message:
          `Gate "${gate}" on "${opName}" is now gate "${successor.gate}" on "${successor.op}", which lists it as an alias, ` +
          `and "${successor.gate}" has a standing pending fact`,
        hint: `Approve that gate instead: chant approve ${successor.op} ${successor.gate}`,
      }));
      return { ok: false };
    }
    console.error(formatInfo(
      `Gate "${gate}" on "${opName}" is an alias of gate "${successor.gate}" on "${successor.op}": ` +
        `the next run of ${successor.op} counts this approval there while the pending fact it answers stands and the plan is the same.`,
    ));
  }

  // #2028: the resolution's link is typed. `--url` wins; otherwise, running
  // inside the PR/MR job that carries the change is itself the address, the
  // same env fallback `--actor` uses. `--note` stays free-text prose.
  const url = opts.url ?? resolveApprovalUrl();
  if (url && !isApprovalUrl(url)) {
    console.error(formatError({
      message: `--url must be an absolute http/https URL (got "${url}")`,
      hint: "Pass the PR/MR link, or omit --url and put prose in --note.",
    }));
    return { ok: false };
  }

  // #2300: an approval is for a plan, so this command has to know which one.
  // `--plan` names it outright; otherwise it comes off the gate's standing
  // pending fact — the plan the run that stopped at this gate produced, which
  // is the plan whoever is typing this just read. There is deliberately no
  // third fallback: approving with no plan in sight is the behaviour
  // INTENTIUS/choudoufu#1026 measured, where the resolution authorised the
  // next run rather than anything anyone had seen.
  // #2574: a component gate's pending facts carry the environment they were
  // recorded in, and an approval answers one environment. `--env` picks it;
  // without it, the newest standing fact decides, and the success line below
  // names the environment it chose.
  const ledgerBefore = await readGateLedger(opName);
  const pendingFor = (all: PendingGateRecord[]): PendingGateRecord[] => {
    const bound = all.some((p) => p.gate === gate && p.environment !== undefined);
    return bound && opts.environment !== undefined ? all.filter((p) => p.environment === opts.environment) : all;
  };
  const standing = latestPendingGate(pendingFor(ledgerBefore.pending), gate);
  const environment = standing?.environment;

  let planDigest: string | undefined;
  if (opts.plan !== undefined) {
    if (!isPlanDigest(opts.plan)) {
      console.error(formatError({
        message: `--plan must be a plan digest ("jcs1-sha256:" or "sha256:", then 64 hex characters), got "${opts.plan}"`,
        hint: "Copy it from the gated run's `plan :` line, or from the pending-gate summary. It is not a plan file path.",
      }));
      return { ok: false };
    }
    planDigest = opts.plan;
  } else {
    if (!standing) {
      console.error(formatError({
        message:
          opts.environment !== undefined && ledgerBefore.pending.some((p) => p.gate === gate && p.environment !== undefined)
            ? `Gate "${gate}" on "${opName}" has no pending fact in environment "${opts.environment}", so there is no plan to approve`
            : `Gate "${gate}" on "${opName}" has no pending fact, so there is no plan to approve`,
        hint:
          `Run \`chant run ${opName}\` first — it plans, stops at the gate, and records the plan this ` +
          `approval would be for. To approve a plan you already have the digest for, pass ` +
          `\`--plan <digest>\`.`,
      }));
      return { ok: false };
    }
    planDigest = standing.planDigest;
  }
  // #3947: a gate that resumes recorded a checkpoint with its pending fact.
  // An approval of that fact's plan copies the checkpoint's digest, the way it
  // copies the plan's, so the run that resumes checks the file against what
  // was approved here. An approval of another plan copies none.
  const checkpointDigest =
    standing?.checkpointDigest !== undefined && samePlanDigest(planDigest, standing.planDigest)
      ? standing.checkpointDigest
      : undefined;

  // chant#2384 — the gate's whole value is that its two halves have different
  // authors. At a shell they do: a person runs, reads the plan, and approves.
  // On MCP and ACP the person's only act was launching the server, and every
  // call after is the model's, so a gate reached over one of those channels and
  // resolved over the same one has no second party in it. Refused by default,
  // the way #2300 refuses a plan nobody approved.
  const origin = opts.origin ?? currentGateOrigin();
  const ledger = await readGateLedger(opName);
  const standingForOrigin = latestPendingGate(pendingFor(ledger.pending), gate);

  // chant#3485: a gate that is never resolved over MCP or ACP says so on its
  // own record, or on its Op's config. No flag overrides this one.
  if (isModelAuthored(origin) && (standingForOrigin?.neverOverMcp || ops.get(opName)?.config.neverOverMcp)) {
    console.error(formatError({
      message: `Gate "${gate}" on "${opName}" is never resolved over ${origin === "acp" ? "ACP" : "MCP"}`,
      hint: `Approvals belong to people: \`chant approve ${opName} ${gate}\` at a shell.`,
    }));
    return { ok: false };
  }
  // #3170: a gate that asks a decision point passes on the point's answer,
  // which the run cites on the ledger. An approval here would count for nothing.
  if (standingForOrigin?.answer) {
    console.error(formatError({
      message: `Gate "${gate}" on "${opName}" asks decision point ${standingForOrigin.answer.point}, so its answer passes the gate, not an approval`,
      hint: `Answer the question: \`chant workspace points answer ${standingForOrigin.answer.id} --answer <value> --by <name>\`, then run \`chant run ${opName}\` again.`,
    }));
    return { ok: false };
  }
  const refusal = sameOriginRefusal(standingForOrigin?.origin, origin);
  if (refusal && !opts.allowSameOrigin) {
    console.error(formatError({
      message: `Gate "${gate}" on "${opName}" cannot be resolved from here: ${refusal}`,
      hint:
        `Approve it from a channel the run did not come from — \`chant approve ${opName} ${gate}\` ` +
        `at a shell is the usual one. If resolving from the same channel genuinely is the intent, ` +
        `pass --allow-same-origin, which records that it was deliberate.`,
    }));
    return { ok: false };
  }

  // #3402: the relay is a principal, on one line (the seal's payload is LF-joined).
  const relayedBy = opts.relayedBy?.trim();
  if (opts.relayedBy !== undefined && (!relayedBy || /[\r\n]/.test(relayedBy))) {
    console.error(formatError({
      message: `--relayed-by needs one principal on one line (got ${JSON.stringify(opts.relayedBy)})`,
      hint: "Name who relayed the approval, such as --relayed-by github:<login> or a principal the signers file lists.",
    }));
    return { ok: false };
  }

  const resolvedBy = opts.actor
    ?? (isModelAuthored(origin)
      // A channel that cannot attest to a name does not get to write one down.
      // "unattested" reads as what it is; a name the model chose would read in
      // the ledger exactly like a name a person gave.
      ? UNATTESTED_APPROVER
      : process.env.GITHUB_ACTOR ?? process.env.GITLAB_USER_LOGIN ?? process.env.USER ?? "unknown");

  // #2508: who this is, as the gate's quorum and policy read it. A model on
  // MCP or ACP is an agent whatever it claims, the same reasoning that gives
  // it `UNATTESTED_APPROVER` for a name.
  const approver: GateApprover = {
    kind: opts.agent || isModelAuthored(origin) ? "agent" : "human",
    ...(opts.roles && opts.roles.length > 0 ? { roles: [...new Set(opts.roles)] } : {}),
  };

  // #3163, ws-080: the declaration at base may require a checkable approver
  // (identity.attribution "identified") and a signed approval for this gate
  // (identity.gates). Both are judged before anything is written.
  const cwd = opts.cwd ?? process.cwd();
  const identity = await import("../../workspace/identity");
  const { scopeSource } = await import("../../workspace/write-scope");
  const scope = scopeSource(cwd);
  try {
    identity.refuseUnidentified(scope, [resolvedBy], opts.actor !== undefined ? "--actor" : "the approver");
    if (relayedBy) identity.refuseUnidentified(scope, [relayedBy], "--relayed-by");
  } catch (err) {
    if (!(err instanceof identity.IdentityError)) throw err;
    console.error(formatError({
      message: `Gate "${gate}" on "${opName}" was not approved: ${err.message}`,
      hint: "Pass --actor <forge identity or signer>, as the surface that signed the person in maps them, for example --actor github:<login>.",
    }));
    return { ok: false };
  }
  const rule = identity.gateAdmissionFrom(scope, gate);
  if (rule && opts.sign === undefined) {
    console.error(formatError({
      message:
        `Gate "${gate}" needs a signed approval: chant.workspace.json at base names it in identity.gates` +
        (rule.requirement.class !== null ? `, from the class ${rule.requirement.class}` : "") +
        `, and this approval is not signed`,
      hint: `chant approve ${opName} ${gate} --actor <principal> --sign [<key file>], with a key ${scope.policy.signersPath} at base lists for that principal.`,
    }));
    return { ok: false };
  }
  const timestamp = new Date().toISOString();
  let seal: GateResolutionRecord["seal"];
  if (opts.sign !== undefined) {
    const { resolveSigningKey, sealGateApproval, gateSealVersion, SealError } = await import("../../workspace/trust/seal");
    try {
      const key = resolveSigningKey(opts.sign, cwd);
      try {
        const sealed = {
          op: opName,
          gate,
          ...(environment !== undefined ? { environment } : {}),
          ...(planDigest !== undefined ? { planDigest } : {}),
          resolvedBy,
          ...(relayedBy ? { relayedBy } : {}),
          timestamp,
          ...(checkpointDigest !== undefined ? { checkpointDigest } : {}),
        };
        // #3947: a seal over a checkpoint digest is seal version 2.
        seal = { ...sealGateApproval(key.file, sealed), ...(gateSealVersion(sealed) === 2 ? { version: 2 as const } : {}) };
      } finally {
        key.cleanup();
      }
    } catch (err) {
      if (!(err instanceof SealError)) throw err;
      console.error(formatError({ message: `Gate "${gate}" on "${opName}" was not approved: ${err.message}` }));
      return { ok: false };
    }
  }
  if (rule) {
    const why = rule.refuses({
      op: opName,
      gate,
      ...(environment !== undefined ? { environment } : {}),
      ...(planDigest !== undefined ? { planDigest } : {}),
      resolvedBy,
      ...(relayedBy ? { relayedBy } : {}),
      timestamp,
      ...(checkpointDigest !== undefined ? { checkpointDigest } : {}),
      seal,
    });
    if (why !== null) {
      console.error(formatError({
        message: `Gate "${gate}" on "${opName}" was not approved: ${why}`,
        hint: `identity.gates.${gate} in chant.workspace.json at base counts only an approval signed by a key ${scope.policy.signersPath} lists for the approver` +
          (rule.requirement.class !== null ? `, who holds the role of the class ${rule.requirement.class}` : "") + ".",
      }));
      return { ok: false };
    }
  }

  // #2508: a gate with a policy has it evaluated for this approval now, while
  // the approver is known, against the context the gated run recorded. The
  // decision is written next to the approval, so a pass can be traced to the
  // rule that allowed it.
  const approval = standingForOrigin?.approval;
  let policyDecision: GatePolicyDecision | undefined;
  if (approval?.policy) {
    try {
      const evaluator = opts.evaluator ?? (await loadGatePolicyEvaluator(approval.policy.lexicon));
      const answer = await evaluator.evaluateGatePolicy(
        approval.policy,
        gatePolicyRequest({
          op: opName,
          gate,
          resolvedBy,
          approver,
          ...(planDigest !== undefined ? { planDigest } : {}),
          ...(approval.context ? { context: approval.context } : {}),
        }),
      );
      policyDecision = {
        policy: approval.policy.name,
        version: approval.policy.version,
        mode: approval.mode,
        contextDigest: gateContextDigest(approval.context),
        decision: answer.decision,
        determining: answer.determining,
        errors: answer.errors,
      };
    } catch (err) {
      console.error(formatError({
        message: `Gate "${gate}" on "${opName}" declares policy "${approval.policy.name}", which could not be evaluated: ${err instanceof Error ? err.message : String(err)}`,
        hint: `Install the ${approval.policy.lexicon} lexicon in this project, or approve from a checkout that has it.`,
      }));
      return { ok: false };
    }
  }

  const { record } = await appendGateResolution({
    op: opName,
    gate,
    resolvedBy,
    ...(relayedBy ? { relayedBy } : {}),
    timestamp,
    ...(seal ? { seal } : {}),
    approver,
    ...(policyDecision ? { policyDecision } : {}),
    ...(opts.note ? { note: opts.note } : {}),
    ...(url ? { url } : {}),
    ...(planDigest !== undefined ? { planDigest } : {}),
    ...(checkpointDigest !== undefined ? { checkpointDigest } : {}),
    ...(environment !== undefined ? { environment } : {}),
    origin,
    ...(refusal && opts.allowSameOrigin ? { sameOriginOverride: true } : {}),
  });
  const push = await reportedPush(
    `The resolution is recorded locally on ${LIFECYCLE_BRANCH}. Until it reaches the remote, ` +
      `a run in another checkout will not see it.`,
  );

  console.error(formatSuccess(
    `Gate "${gate}" on "${opName}" resolved by ${record.resolvedBy}` +
      (record.relayedBy ? `, relayed by ${record.relayedBy},` : "") +
      ` at ${record.timestamp}` +
      (record.url ? ` (${record.url})` : "") +
      (record.seal ? `, signed with ${record.seal.key}` : "") +
      push.suffix,
  ));
  if (record.planDigest) {
    console.error(formatInfo(
      `This approves the plan ${record.planDigest}` +
        (record.environment !== undefined ? ` in environment "${record.environment}"` : "") +
        ", and only that plan. A run whose fresh plan differs refuses rather than applying it.",
    ));
  }
  if (record.checkpointDigest) {
    console.error(formatInfo(
      `The next run resumes at this gate from run ${standing?.runId ?? "(unknown)"}'s checkpoint ${record.checkpointDigest}, ` +
        "after it plans again. A moved plan or another commit starts it at the first phase.",
    ));
  }
  if (approval) {
    for (const line of describeApprovalProgress(approval, record, ledger.resolutions, standingForOrigin, ledger.pending)) {
      console.error(formatInfo(line));
    }
  }
  return { ok: true, record, pushed: push.pushed };
}

/**
 * What a just-recorded approval did to a gate with an `approval` block
 * (#2508): the policy's decision and whether it binds, then the quorum count
 * for this plan. The run decides the gate from the ledger; these lines only
 * say what it will find.
 */
export function describeApprovalProgress(
  approval: ResolvedGateApproval,
  record: GateResolutionRecord,
  prior: GateResolutionRecord[],
  standing: PendingGateRecord | undefined,
  pending: readonly PendingGateRecord[] = standing ? [standing] : [],
): string[] {
  const lines: string[] = [];
  const decision = record.policyDecision;
  if (decision) {
    const rules = decision.determining.length > 0 ? ` (${decision.determining.join(", ")})` : "";
    const binds =
      approval.mode === "enforce"
        ? decision.decision === "allow"
          ? "In enforce mode this permit passes the gate on its own."
          : "In enforce mode only a permit passes the gate on its own, so this approval counts only toward the quorum."
        : "The gate is in log-only mode, so the decision is recorded and does not change the outcome.";
    lines.push(`Policy "${decision.policy}" ${decision.version}: ${decision.decision}${rules}. ${binds}`);
    for (const error of decision.errors) lines.push(`Policy evaluation error: ${error}`);
  }

  const since = standing?.timestamp ?? new Date(0).toISOString();
  // #3206: count the humans the way the run will, back past facts re-recorded for this plan.
  const humansSince = standing && samePlanDigest(standing.planDigest, record.planDigest) ? humanQuorumSince(pending, standing) : since;
  const tally = tallyGateApprovals([...prior, record], record.gate, since, record.planDigest, approval, humansSince);
  const roles = approval.quorum?.roles ? ` with role ${approval.quorum.roles.join(" or ")}` : "";
  const who = tally.counted.map((r) => r.resolvedBy).join(", ") || "none yet";
  lines.push(`Quorum: ${tally.counted.length} of ${tally.need} human approval(s)${roles} for this plan (${who}).`);
  if (!tally.counted.includes(record)) {
    lines.push(
      approverOf(record).kind === "agent"
        ? "An agent's approval does not count toward the quorum."
        : `This approval does not count toward the quorum: the approver claims none of its roles (${approval.quorum?.roles?.join(", ")}).`,
    );
  }
  return lines;
}
