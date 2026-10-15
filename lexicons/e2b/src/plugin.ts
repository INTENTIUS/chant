import type { LexiconPlugin } from "@intentius/chant/lexicon";
import { createSkillsLoader } from "@intentius/chant/lexicon-plugin-helpers";
import { e2bSerializer } from "./serializer";
import { e2bConfigSchema } from "./config";
import { createE2bOpRuntime } from "./op/runtime";

/**
 * e2b lexicon plugin: `chant run <op> --on e2b`.
 *
 * The lexicon is its op runtime. It declares no resource types, so the
 * generate, validate, coverage and package steps every lexicon has are
 * no-ops here.
 */
export const e2bPlugin: LexiconPlugin = {
  name: "e2b",
  serializer: e2bSerializer,
  configSchema: e2bConfigSchema,

  // Construction is pure: the key, the steward and the repository are
  // resolved on the first call, so loading the plugin costs nothing.
  opRuntime: createE2bOpRuntime(),

  skills: createSkillsLoader(import.meta.url, [
    {
      file: "chant-e2b-ops.md",
      name: "chant-e2b-ops",
      description: "Run chant ops on a steward sandbox with `--on e2b`, on hosted E2B or any API that speaks E2B's",
      triggers: [{ type: "context" as const, value: "e2b" }],
    },
  ]),

  async generate(): Promise<void> {},
  async validate(): Promise<void> {},
  async coverage(): Promise<void> {},
  async package(): Promise<void> {},
};
