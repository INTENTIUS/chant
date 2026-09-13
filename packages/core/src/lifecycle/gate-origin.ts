/**
 * Which channel a gate fact was authored on — chant#2384.
 *
 * The gate is the strongest thing chant says about agent-driven change: a run
 * that reaches an unapproved gate records a pending fact and exits 3, and since
 * #2300 a resolution counts only for the plan it names. That property rests on
 * the two halves being authored by different parties.
 *
 * `gate-ledger.ts` already states the trust boundary, and is right about it:
 *
 * > this record is *not* itself an authorization check — anyone who can run
 * > `chant approve` locally can write one, the same trust boundary a local
 * > commit already has.
 *
 * That holds at a shell. A person who can run `chant approve` can also run
 * `chant run`, and the ledger records what they did. It stops holding on MCP
 * and ACP, because the person's only act was launching the server once; every
 * call after that is authored by the model. `op-run` returns the gate it
 * stopped on and `op-approve` resolves it, so the same caller writes both
 * halves and the separation is gone.
 *
 * The ledger could not tell those situations apart, because both produce a
 * `resolvedBy` string with no record of where it came from. This records the
 * where.
 *
 * ## Why an ambient value rather than a parameter
 *
 * A channel is a property of the process, not of a call. A `chant mcp` server
 * is launched once by a person and then serves a model for its lifetime; there
 * is no call on it that is not model-authored. So the origin is established at
 * the entry point and read by whoever writes a ledger line, rather than
 * threaded through every runtime, executor and step that sits between them.
 *
 * This is provenance, not authentication. It records the door a fact came
 * through. It does not prove who was behind it, and nothing here should be read
 * as if it did — see {@link UNATTESTED_APPROVER}.
 */

/** A channel a gate fact can be authored on. */
export type GateOrigin = "cli" | "mcp" | "acp";

/**
 * Channels where the caller is a model rather than a person.
 *
 * The distinction this type exists to draw. On `cli` a human typed each
 * command and the existing trust boundary is the right one. On `mcp` and `acp`
 * a human launched a server and a model authored everything after, so a gate
 * resolved from the same channel that produced it has no second party in it.
 */
const MODEL_AUTHORED: ReadonlySet<GateOrigin> = new Set<GateOrigin>(["mcp", "acp"]);

/** Whether a channel's calls are authored by a model rather than by a person. */
export function isModelAuthored(origin: GateOrigin | undefined): boolean {
  return origin !== undefined && MODEL_AUTHORED.has(origin);
}

/**
 * What `resolvedBy` says for a resolution recorded on a channel that cannot
 * attest to a name.
 *
 * `op-approve` used to take a free-text `approver` and write it down. Recording
 * a name the model chose is worse than recording nothing, because it reads in
 * the ledger exactly like a name a person gave. This is the honest value.
 */
export const UNATTESTED_APPROVER = "unattested";

let ambient: GateOrigin = "cli";

/**
 * Declare the channel this process serves. Called once at an entry point, not
 * per call: `chant mcp` sets `"mcp"` before it serves anything, `chant acp`
 * sets `"acp"`, and the CLI leaves the default.
 */
export function setGateOrigin(origin: GateOrigin): void {
  ambient = origin;
}

/** The channel this process serves. `"cli"` unless an entry point said otherwise. */
export function currentGateOrigin(): GateOrigin {
  return ambient;
}

/** Restore the default. For tests, which must not leak a channel into each other. */
export function resetGateOrigin(): void {
  ambient = "cli";
}

/**
 * Why a resolution from this origin cannot answer a pending fact from the same
 * one, or `undefined` when it can.
 *
 * The rule, and the two cases it deliberately leaves alone:
 *
 *   - Same channel, model-authored. Refused. `op-run` produced the pending
 *     fact and `op-approve` would resolve it, both authored by the same model
 *     in the same session. Nothing about that is an approval.
 *   - Same channel, `cli`. Allowed. A person ran `chant run`, read the plan and
 *     ran `chant approve`. That is the intended workflow and the trust boundary
 *     the ledger already documents.
 *   - Different channels. Allowed, and the point: a model's run approved by a
 *     person at a shell is exactly the separation the gate is for.
 */
export function sameOriginRefusal(
  pendingOrigin: GateOrigin | undefined,
  resolutionOrigin: GateOrigin,
): string | undefined {
  if (!isModelAuthored(resolutionOrigin)) return undefined;
  if (pendingOrigin !== resolutionOrigin) return undefined;
  return (
    `the gate was reached over ${resolutionOrigin} and this resolution arrived over ${resolutionOrigin} too, ` +
    "so the same caller wrote both halves"
  );
}
