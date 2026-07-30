/**
 * ConciergeStack — a locked-down Environment + Agent pair with the
 * secure-by-construction defaults for agents that touch anything
 * sensitive:
 *
 *   - `networking_type: limited` with an explicit allowlist (empty =
 *     deny-all egress — fountain's isolation mode)
 *   - `allowed_vault_ids: []` — no conversation may override the
 *     reviewed environment at spawn
 *   - the `managed-by: chant` marker on both, so owned-only
 *     reconcile/prune and drift filtering see them
 *
 * Loosening any of it is a visible, reviewable act: pass an allowlist,
 * pass vault ids, or drop to the raw classes.
 */

import { Environment, Agent } from "../generated/index";

export interface ConciergeStackOpts {
  /** Base name; the environment is `<name>-env`, the agent `<name>`. */
  name: string;
  /** Canonical provider/model_id. */
  model: string;
  /** Agent runtime. Default "claude". */
  runtime?: "claude" | "codex" | "gemini" | "opencode";
  /** Egress allowlist. Default [] — deny all egress. */
  allowedHosts?: string[];
  /** Vaults that may attach at conversation create. Default [] — none. */
  allowedVaultIds?: string[];
  /** Skill installs. Pin github-sourced entries with `ref`. */
  skills?: Array<Record<string, unknown>>;
  /** MCP server definitions (use ${VAR} references for secrets). */
  mcpServers?: Record<string, unknown>;
  /** System prompt. */
  system?: string;
  /** Extra environment fields (packages, env_vars, setup_script, repositories). */
  environment?: Record<string, unknown>;
  /** Extra metadata merged over the managed-by marker. */
  metadata?: Record<string, unknown>;
}

export interface ConciergeStackResources {
  environment: InstanceType<typeof Environment>;
  agent: InstanceType<typeof Agent>;
}

export function ConciergeStack(opts: ConciergeStackOpts): ConciergeStackResources {
  const metadata = { "managed-by": "chant", ...(opts.metadata ?? {}) };

  const environment = new Environment({
    name: `${opts.name}-env`,
    networking_type: "limited",
    networking_config: { allowed_hosts: opts.allowedHosts ?? [] },
    metadata,
    ...(opts.environment ?? {}),
  });

  const agent = new Agent({
    name: opts.name,
    model: opts.model,
    runtime: opts.runtime ?? "claude",
    environment,
    allowed_vault_ids: opts.allowedVaultIds ?? [],
    ...(opts.skills ? { skills: opts.skills } : {}),
    ...(opts.mcpServers ? { mcp_servers: opts.mcpServers } : {}),
    ...(opts.system !== undefined ? { system: opts.system } : {}),
    metadata,
  });

  return { environment, agent };
}
