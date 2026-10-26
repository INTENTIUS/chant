/**
 * The `pulumi` namespace in `chant.config.ts` (#4453).
 *
 * Nobody writes it by hand today. `chant workspace graph` writes `member`
 * into the reader project it makes for a member of kind `pulumi` (see
 * `workspace-kinds.json`): `dir` is the member's directory, absolute, and
 * `label` names the entities. The graph is the checked-in
 * `stack-export.json` there; the graph read never runs `pulumi`.
 */
import { z } from "zod";
import type { ChantConfig } from "@intentius/chant/config";

export const pulumiMemberConfigSchema = z.strictObject({
  dir: z.string().min(1),
  label: z.string().optional(),
  /**
   * What runs the member's stack (#4453): `pulumi`, or `plunge`, whose
   * `plunge drift` reads drift in its place. Omit to take it from the
   * backend URL in `Pulumi.yaml` (`./run.ts`, `pulumiMemberEngine`).
   */
  engine: z.enum(["pulumi", "plunge"]).optional(),
  /**
   * The stack the drift read passes as `--stack` (#4496). Omit to take the
   * stack the checked-in `stack-export.json` names in its URNs.
   */
  stack: z.string().min(1).optional(),
});

export const pulumiConfigSchema = z.strictObject({
  /** One pulumi workspace member read into the graph (#3179). */
  member: pulumiMemberConfigSchema.optional(),
});

export type PulumiConfig = z.infer<typeof pulumiConfigSchema>;

declare module "@intentius/chant/config" {
  interface ChantConfig {
    pulumi?: PulumiConfig;
  }
}

/** Compile-time proof that the augmentation reaches `ChantConfig`. */
export type PulumiConfigNamespace = NonNullable<ChantConfig["pulumi"]>;
