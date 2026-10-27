/** The words terragucci and plywood pass (chant#4550's design table), for tests. */
export const PLYWOOD = {
  product: "plywood",
  stages: { plan: "preview", apply: "up" },
  verbs: { plan: ["preview", "previewed"] as [string, string], apply: ["update", "updated"] as [string, string] },
  noun: ["stack", "stacks"] as [string, string],
  commands: { preview: "plan" as const, up: "apply" as const, lock: "lock" as const, unlock: "unlock" as const },
  approve: "plywood approve {gate} --plan {digest} {sign}",
  override: "plywood override {gate} --rule {rule} --reason <text>",
  op: "pulumi-up",
  prGate: "up",
  gateName: "wave-{k}",
  approval: "pull-request" as const,
  bin: "npx --no-install plywood",
};
export const TERRAGUCCI = {
  product: "terragucci",
  noun: ["root", "roots"] as [string, string],
  commands: { plan: "plan" as const, apply: "apply" as const, lock: "lock" as const, unlock: "unlock" as const, agent: "agent" as const },
  aliases: [
    { from: "atlantis plan", command: "plan" as const, when: "TG_ATLANTIS_COMMENTS" },
    { from: "atlantis apply", command: "apply" as const, when: "TG_ATLANTIS_COMMENTS" },
  ],
  approve: "terragucci approve {gate} --plan {digest} {sign}",
  op: "tf-apply",
  gateName: "wave-{k}",
  approval: "per-wave" as const,
  adoptMarkers: ["<!-- terragucci:waves -->"],
};

