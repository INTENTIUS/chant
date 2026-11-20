/**
 * `chant reject <op> <gate> --reason <text>` (#5354): turn down the digest a
 * gate waits on. At a pipeline stage's gate (`chant reject <pipeline>
 * <stage>`) that digest is a release's, so the release does not enter the
 * stage, and `components promote` says who rejected it and why.
 *
 * It records the rejection the way `chant approve` records an approval: the
 * digest from the gate's standing pending fact (or `--plan`), its
 * environment and release from the same fact, the actor from `--actor`, the
 * CI or the shell, a seal with `--sign` or a signature made elsewhere with
 * `--signature` and `--at` over the statement `--statement` prints, and the
 * workspace's `identity.gates` rule for the gate judged before anything is
 * written. A rejection is final for the digest it names: nothing withdraws
 * it, and more approvals do not clear it. A new release goes through again.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { latestPendingGate } from "../../lifecycle/gate-ledger";
import { currentGateOrigin, isModelAuthored, UNATTESTED_APPROVER, type GateOrigin } from "../../lifecycle/gate-origin";
import { isPlanDigest, samePlanDigest } from "../../lifecycle/plan-digest";
import { checkGateSignature, WEBAUTHN_SEAL_KIND } from "../../lifecycle/gate-seal";
import { webAuthnChallenge } from "../../lifecycle/gate-webauthn";
import { readExternalSignature } from "../../lifecycle/gate-statement";
import { GATE_REJECTION_NAMESPACE, gateRejectionPayload, rejectionReasonProblem, type GateRejectionRecord, type SealedGateRejection } from "../../lifecycle/gate-rejection";
import type { GateApprovalSeal } from "../../lifecycle/gate-ledger";
import { ledgerRecordingOff, NO_RECORD_ENV } from "../../lifecycle/no-record";
import { gitGateLedgerPort, type GateLedgerPort } from "../../op/gate";
import type { IdentitySource } from "../../workspace/identity";
import type { GateAdmission } from "../../workspace/identity";
import { actorFromEnv } from "../../actor";
import { formatError, formatInfo, formatSuccess } from "../format";
import type { CommandContext } from "../registry";

/** What `chant reject` takes. */
export interface GateRejectionOptions {
  /** `--reason`: why, on one line. Required. */
  reason?: string;
  /** `--actor` / `--approver`; falls back to the CI or shell identity. */
  actor?: string;
  /** `--plan <digest>`: the digest rejected. Default: the gate's standing pending fact's. */
  plan?: string;
  /** `--env <env>`: which environment's pending fact, on a gate whose facts name one. */
  environment?: string;
  /** `--release <digest>`: the release rejected, when no pending fact names it. */
  release?: string;
  /** `--url`: where the rejection was made. */
  url?: string;
  /** `--sign [<key file>]`: seal it with an ssh key. */
  sign?: string | true;
  /** `--signature <file>`: a signature made elsewhere over the statement; `-` reads stdin. */
  signature?: string;
  /** `--at <timestamp>`: the statement's time. */
  at?: string;
  /** `--agent`: an agent's rejection, recorded and counted for nothing. */
  agent?: boolean;
  /** The channel it arrived on. Default: the process's. */
  origin?: GateOrigin;
  /** The repository. Default: the process's directory. */
  cwd?: string;
  /** The gate ledger. Default: `chant/lifecycle` in `cwd`. */
  port?: GateLedgerPort;
  /** The declaration, trust policy and `identity.gates` rule at base. Default: read at the base of `cwd`. */
  scope?: IdentitySource & { rule: GateAdmission | null; signers: Parameters<typeof checkGateSignature>[0] };
}

/** The bytes a rejection signed elsewhere signs, as `--statement` prints them. */
export interface GateRejectionStatement {
  namespace: string;
  text: string;
  statement: string;
  challenge: string;
  rejection: SealedGateRejection;
}

export type GateRejectionOutcome = { ok: true; record: GateRejectionRecord; pushed: boolean; pushWarning?: string } | { ok: false; message: string; hint?: string };

/** How far in the future `--at` may be, for a clock a little ahead of this one. */
const AT_SKEW_MS = 5 * 60 * 1000;

export async function scopeAt(cwd: string, gate: string): Promise<NonNullable<GateRejectionOptions["scope"]>> {
  const { scopeSource } = await import("../../workspace/write-scope");
  const { gateAdmissionFrom } = await import("../../workspace/identity");
  const scope = scopeSource(cwd);
  return { declaration: scope.declaration, policy: scope.policy, rule: gateAdmissionFrom(scope, gate), signers: scope.policy };
}

/**
 * Record a rejection, or return the statement to sign with
 * `statementOnly`. Writes nothing when it refuses; the outcome says why.
 */
export async function recordGateRejection(op: string, gate: string, opts: GateRejectionOptions, statementOnly = false): Promise<GateRejectionOutcome | { statement: GateRejectionStatement }> {
  const refuse = (message: string, hint?: string): GateRejectionOutcome => ({ ok: false, message: `Gate "${gate}" on "${op}" was not rejected: ${message}`, ...(hint ? { hint } : {}) });
  const reasonProblem = rejectionReasonProblem(opts.reason);
  if (reasonProblem) return refuse(reasonProblem);
  const reason = opts.reason!.trim();
  if (!statementOnly && ledgerRecordingOff()) return refuse(`${NO_RECORD_ENV} is set, so nothing is written to chant/lifecycle`, `Unset ${NO_RECORD_ENV} to reject the release.`);
  const cwd = opts.cwd ?? process.cwd();
  const port = opts.port ?? gitGateLedgerPort(opts.cwd !== undefined ? { cwd: opts.cwd } : undefined);
  if (!port.appendRejection) return refuse("this gate ledger keeps no rejections");

  let ledger: Awaited<ReturnType<GateLedgerPort["read"]>>;
  try {
    ledger = await port.read(op);
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err), "The pending fact this answers lives on chant/lifecycle; fetch it and run again.");
  }
  const pending = opts.environment !== undefined ? ledger.pending.filter((p) => p.environment === opts.environment) : ledger.pending;
  const standing = latestPendingGate(pending, gate);

  let planDigest: string;
  if (opts.plan !== undefined) {
    if (!isPlanDigest(opts.plan)) return refuse(`--plan must be a plan digest ("jcs1-sha256:" or "sha256:", then 64 hex characters), got "${opts.plan}"`);
    planDigest = opts.plan;
  } else {
    if (!standing?.planDigest) {
      return refuse(
        `the gate has no pending fact${opts.environment !== undefined ? ` in environment "${opts.environment}"` : ""}, so there is no release to reject`,
        `Name the release's digest: chant reject ${op} ${gate} --plan <digest> --reason <text>.`,
      );
    }
    planDigest = standing.planDigest;
  }
  const answers = standing !== undefined && samePlanDigest(standing.planDigest, planDigest);
  const environment = opts.environment ?? (answers ? standing!.environment : undefined);
  if (opts.release !== undefined && !isPlanDigest(opts.release)) return refuse(`--release must be a release digest, got "${opts.release}"`);
  const releaseDigest = opts.release ?? (answers ? standing!.releaseDigest : undefined);

  const origin = opts.origin ?? currentGateOrigin();
  const rejectedBy = opts.actor ?? (isModelAuthored(origin) ? UNATTESTED_APPROVER : actorFromEnv());
  const kind: "agent" | "human" = opts.agent || isModelAuthored(origin) ? "agent" : "human";

  const scope = opts.scope ?? (await scopeAt(cwd, gate));
  const identity = await import("../../workspace/identity");
  try {
    identity.refuseUnidentified(scope, [rejectedBy], opts.actor !== undefined ? "--actor" : "the rejecter");
  } catch (err) {
    if (!(err instanceof identity.IdentityError)) throw err;
    return refuse(err.message, "Pass --actor <forge identity or signer>, for example --actor github:<login>.");
  }

  if (opts.signature !== undefined && opts.sign !== undefined) return refuse("--sign signs here and --signature brings a signature made elsewhere; pass one of them");
  if (opts.at !== undefined && !statementOnly && opts.signature === undefined) return refuse("--at sets the time of a statement signed elsewhere, so it goes with --statement or --signature");
  if (opts.signature !== undefined && opts.at === undefined) return refuse("--signature needs --at <timestamp>, the statement's time, since the signature covers it");
  let timestamp = new Date().toISOString();
  if (opts.at !== undefined) {
    const at = Date.parse(opts.at);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(opts.at) || Number.isNaN(at) || new Date(at).toISOString() !== opts.at) return refuse(`--at takes a UTC time as chant writes one, such as ${timestamp}`);
    if (at > Date.now() + AT_SKEW_MS) return refuse(`--at ${opts.at} is in the future`);
    timestamp = opts.at;
  }
  const sealed: SealedGateRejection = {
    op,
    gate,
    ...(environment !== undefined ? { environment } : {}),
    planDigest,
    ...(releaseDigest !== undefined ? { releaseDigest } : {}),
    rejectedBy,
    timestamp,
    reason,
  };
  if (statementOnly) {
    const bytes = gateRejectionPayload(sealed);
    return { statement: { namespace: GATE_REJECTION_NAMESPACE, text: bytes.toString("utf-8"), statement: bytes.toString("base64"), challenge: webAuthnChallenge(bytes), rejection: sealed } };
  }

  // #3163: a gate the workspace's identity.gates names counts only a signed rejection, as it counts only a signed approval.
  if (scope.rule && opts.sign === undefined && opts.signature === undefined) {
    return refuse(
      `chant.workspace.json at base names gate "${gate}" in identity.gates, so only a signed rejection counts there, and this one is not signed`,
      `chant reject ${op} ${gate} --actor <principal> --sign [<key file>] --reason <text>, with a key ${scope.policy.signersPath} at base lists for that principal.`,
    );
  }
  let seal: GateApprovalSeal | undefined;
  if (opts.signature !== undefined) {
    let text: string;
    try {
      text = opts.signature === "-" ? readFileSync(0, "utf-8") : readFileSync(resolvePath(cwd, opts.signature), "utf-8");
    } catch (err) {
      return refuse(`--signature ${opts.signature} can't be read: ${err instanceof Error ? err.message : String(err)}`);
    }
    const sig = readExternalSignature(text);
    if ("problem" in sig) return refuse(`--signature ${opts.signature}: ${sig.problem}`);
    const candidate: GateApprovalSeal =
      sig.kind === "ssh"
        ? { signer: rejectedBy, key: "", signature: sig.signature }
        : { kind: WEBAUTHN_SEAL_KIND, signer: rejectedBy, key: sig.assertion.id, signature: sig.assertion.signature, clientDataJSON: sig.assertion.clientDataJSON, authenticatorData: sig.assertion.authenticatorData };
    const r = checkGateSignature(scope.signers, rejectedBy, candidate as unknown as { signature: string } & Record<string, unknown>, gateRejectionPayload(sealed), GATE_REJECTION_NAMESPACE);
    if (!r.ok) return refuse(r.unlisted ? `${rejectedBy} has no key or passkey listed at base, so a signature made elsewhere can't be checked` : `the signature does not verify for ${rejectedBy} over this rejection's statement: ${r.reason}`);
    seal = { ...candidate, key: r.key };
  }
  if (opts.sign !== undefined) {
    const { resolveSigningKey, sealGateRejection, SealError } = await import("../../workspace/trust/seal");
    try {
      const key = resolveSigningKey(opts.sign, cwd);
      try {
        seal = sealGateRejection(key.file, sealed);
      } finally {
        key.cleanup();
      }
    } catch (err) {
      if (!(err instanceof SealError)) throw err;
      return refuse(err.message);
    }
  }
  const record: GateRejectionRecord = {
    version: 1,
    kind: "rejection",
    ...sealed,
    ...(opts.url !== undefined ? { url: opts.url } : {}),
    approver: { kind },
    origin,
    ...(answers && standing!.gitSha ? { gitSha: standing!.gitSha } : {}),
    ...(seal ? { seal } : {}),
  };
  if (scope.rule) {
    const why = scope.rule.refusesRejection(record);
    if (why !== null) return refuse(why);
  }
  const push = await port.appendRejection(record);
  return { ok: true, record, pushed: push.pushed, ...(push.pushWarning ? { pushWarning: push.pushWarning } : {}) };
}

/** `chant reject <op> <gate> --reason <text>`. */
export async function runReject(ctx: CommandContext): Promise<number> {
  const op = ctx.args.path;
  const gate = ctx.args.extraPositional;
  if (!op || op === "." || !gate) {
    console.error(formatError({ message: "Usage: chant reject <op> <gate> --reason <text> [--plan <digest>] [--env <env>] [--release <digest>] [--actor <name>] [--sign [<key file>]]" }));
    return 1;
  }
  const opts: GateRejectionOptions = {
    ...(ctx.args.reason !== undefined ? { reason: ctx.args.reason } : {}),
    ...((ctx.args.approver ?? ctx.args.actor) !== undefined ? { actor: ctx.args.approver ?? ctx.args.actor } : {}),
    ...(ctx.args.plan !== undefined ? { plan: ctx.args.plan } : {}),
    ...(ctx.args.env !== undefined ? { environment: ctx.args.env } : {}),
    ...(ctx.args.release !== undefined ? { release: ctx.args.release } : {}),
    ...(ctx.args.url !== undefined ? { url: ctx.args.url } : {}),
    ...(ctx.args.sign !== undefined ? { sign: ctx.args.sign } : {}),
    ...(ctx.args.signature !== undefined ? { signature: ctx.args.signature } : {}),
    ...(ctx.args.at !== undefined ? { at: ctx.args.at } : {}),
    ...(ctx.args.agent ? { agent: true } : {}),
  };
  const out = await recordGateRejection(op, gate, opts, ctx.args.statement === true);
  if ("statement" in out) {
    console.log(JSON.stringify(out.statement, null, 2));
    console.error(formatInfo(
      `Have ${out.statement.rejection.rejectedBy} sign these bytes (an ssh key in the ${out.statement.namespace} namespace, or a passkey with challenge ${out.statement.challenge}), ` +
        `then record it with --signature <file> --at ${out.statement.rejection.timestamp} and the same --actor, --plan and --reason.`,
    ));
    return 0;
  }
  if (!out.ok) {
    console.error(formatError({ message: out.message, ...(out.hint ? { hint: out.hint } : {}) }));
    return 1;
  }
  const r = out.record;
  const where = r.releaseDigest !== undefined ? `release ${r.releaseDigest}` : `plan ${r.planDigest}`;
  console.error(formatSuccess(`${where} rejected at ${op} ${gate}${r.environment !== undefined ? ` (${r.environment})` : ""} by ${r.rejectedBy} at ${r.timestamp}${r.seal ? ", signed" : ""}${out.pushed ? "" : " (local only: the push did not land)"}`));
  console.error(formatInfo("It does not go through this gate, and more approvals do not clear the rejection. A new release goes through the gate again."));
  return 0;
}
