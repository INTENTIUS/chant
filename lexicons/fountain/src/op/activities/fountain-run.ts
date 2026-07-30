/**
 * fountainRun — start a conversation from a declared Agent and follow it
 * to a terminal status.
 *
 * Conversations are runs, not declarables (the one fountain kind the
 * lexicon deliberately does not model as a resource). This op is the
 * imperative half: resolve the agent by name, POST the conversation,
 * poll until `completed | failed | timed_out | terminated`, and terminate
 * on deadline so a hung run never outlives the op that started it.
 */

import {
  resolveEndpoint,
  resolveToken,
  defaultFountainHttp,
  type FountainHttp,
} from "./fountain-apply";

export const TERMINAL_STATUSES = new Set(["completed", "failed", "timed_out", "terminated"]);

export interface FountainRunArgs {
  /** Agent name (resolved against /api/agents) or a raw agent id. */
  agent: string;
  prompt?: string;
  /** Optional vault to attach (subject to the agent's allowlist upstream). */
  vaultId?: string;
  endpoint?: string;
  token?: string;
  /** Give up (and terminate the conversation) after this long. Default 10 min. */
  timeoutMs?: number;
  /** Poll interval. Default 5s. */
  pollMs?: number;
  /** Injectable clock/sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface FountainRunResult {
  conversationId: string;
  status: string;
  /** True when the op hit its deadline and terminated the conversation. */
  terminatedByDeadline: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveAgentId(http: FountainHttp, agent: string): Promise<string> {
  if (UUID_RE.test(agent)) return agent;
  const { status, json } = await http("GET", `/api/agents?search=${encodeURIComponent(agent)}`);
  if (status !== 200) throw new Error(`fountainRun: agent lookup failed (${status})`);
  const data = (json as { data?: Array<{ id: string; name: string }> })?.data ?? [];
  const exact = data.find((a) => a.name === agent);
  if (!exact) throw new Error(`fountainRun: no agent named "${agent}"`);
  return exact.id;
}

export async function fountainRun(
  args: FountainRunArgs,
  http?: FountainHttp,
): Promise<FountainRunResult> {
  const endpoint = resolveEndpoint(args);
  const client = http ?? defaultFountainHttp(endpoint, resolveToken(args));
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = args.timeoutMs ?? 600_000;
  const pollMs = args.pollMs ?? 5_000;

  const agentId = await resolveAgentId(client, args.agent);

  const createBody: Record<string, unknown> = { agent_id: agentId };
  if (args.prompt !== undefined) createBody.prompt = args.prompt;
  if (args.vaultId !== undefined) createBody.vault_id = args.vaultId;

  const created = await client("POST", "/api/conversations", createBody);
  if (created.status !== 201 && created.status !== 200) {
    throw new Error(`fountainRun: conversation create failed (${created.status})`);
  }
  const conversationId = (created.json as { data?: { id?: string } })?.data?.id;
  if (!conversationId) throw new Error("fountainRun: conversation create returned no id");

  const deadline = Date.now() + timeoutMs;
  let status = "pending";
  while (Date.now() < deadline) {
    const res = await client("GET", `/api/conversations/${conversationId}`);
    if (res.status === 200) {
      status = (res.json as { data?: { status?: string } })?.data?.status ?? status;
      if (TERMINAL_STATUSES.has(status)) {
        return { conversationId, status, terminatedByDeadline: false };
      }
    }
    await sleep(pollMs);
  }

  // Deadline: end the conversation so the sandbox does not outlive the op.
  await client("POST", `/api/conversations/${conversationId}/terminate`);
  return { conversationId, status: "terminated", terminatedByDeadline: true };
}
