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
