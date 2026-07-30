import { describe, expect, it } from "vitest";
import { ConciergeStack } from "./concierge-stack";

describe("ConciergeStack", () => {
  it("defaults to deny-all egress, no vaults, and the ownership marker", () => {
    const { environment, agent } = ConciergeStack({
      name: "concierge",
      model: "anthropic/claude-sonnet-4-6",
    });

    const env = (environment as unknown as { props: Record<string, unknown> }).props;
    const a = (agent as unknown as { props: Record<string, unknown> }).props;
    expect(env.networking_type).toBe("limited");
    expect((env.networking_config as { allowed_hosts: string[] }).allowed_hosts).toEqual([]);
    expect((env.metadata as Record<string, unknown>)["managed-by"]).toBe("chant");
    expect(a.allowed_vault_ids).toEqual([]);
    expect(a.environment).toBe(environment);
    expect(a.runtime).toBe("claude");
  });

  it("loosening is explicit", () => {
    const { environment, agent } = ConciergeStack({
      name: "helper",
      model: "anthropic/claude-sonnet-4-6",
      allowedHosts: ["github.com"],
      allowedVaultIds: ["vault-1"],
      metadata: { team: "payments" },
    });

    const env = (environment as unknown as { props: Record<string, unknown> }).props;
    expect((env.networking_config as { allowed_hosts: string[] }).allowed_hosts).toEqual(["github.com"]);
    expect((agent as unknown as { props: Record<string, unknown> }).props.allowed_vault_ids).toEqual(["vault-1"]);
    expect((env.metadata as Record<string, unknown>).team).toBe("payments");
  });
});
