/**
 * Pulumi lexicon plugin (#4453).
 *
 * The lexicon declares no resource types, so `generate`, `validate`,
 * `coverage` and `package` have nothing to do. What it does carry:
 *
 * - the `pulumi` workspace member kind (`workspace-kinds.json`), moved here
 *   from the terraform lexicon, whose graph block reads a member through
 *   {@link pulumiPlugin}'s `buildRoots` (`./workspace-member.ts`);
 * - the change-set adapter over `pulumi preview --json` (`./change-set.ts`);
 * - the drift adapter over `pulumi refresh --preview-only --json`
 *   (`./drift-record.ts`);
 * - the runner that calls those two commands and no other (`./run.ts`);
 * - the stack outputs `member-outputs` feeds into chant parameters
 *   (`./stack-outputs.ts`, `./member-outputs.ts`, #4455), contributed
 *   through {@link pulumiCapabilityPlugin} (`./capability-plugin.ts`);
 * - `readDrift`, which `chant workspace drift --member <pulumi member>`
 *   reaches through `chant lifecycle drift` in the member's reader project
 *   (`./drift-read.ts`).
 */
import type { LexiconPlugin } from "@intentius/chant/lexicon";
import { pulumiConfigSchema, type PulumiConfig } from "./config";
import { pulumiSerializer } from "./serializer";
import { lastMemberReport, readPulumiMember, setLastMemberReport } from "./workspace-member";

export const pulumiPlugin: LexiconPlugin = {
  name: "pulumi",
  serializer: pulumiSerializer,
  configSchema: pulumiConfigSchema,

  // A pulumi workspace member's reader project (#3179): its checked-in stack
  // export, never the program. See ./workspace-member.ts.
  async buildRoots(ctx) {
    setLastMemberReport(undefined);
    const member = (ctx.config as { pulumi?: PulumiConfig }).pulumi?.member;
    if (!member) return { entities: new Map() };
    const read = readPulumiMember({ member });
    setLastMemberReport(read.report);
    return { entities: read.entities, warnings: read.warnings };
  },

  graphMeta() {
    const report = lastMemberReport();
    return report ? { pulumiMember: report } : undefined;
  },

  /**
   * The member's drift, as drift-record stream lines (#4455): `pulumi
   * refresh --preview-only --target` per resource, or `plunge drift
   * --resource --stream` for a member on plunge. See `./drift-read.ts`.
   */
  async readDrift(options) {
    const { readPulumiDrift } = await import("./drift-read");
    return readPulumiDrift(options);
  },

  // No declarable kinds, so no upstream spec to generate from, check against or measure.
  async generate(): Promise<void> {},
  async validate(): Promise<void> {},
  async coverage(): Promise<void> {},
  async package(): Promise<void> {},
};
