import type { ChantConfig } from "@intentius/chant";

// The `fly` lexicon provides the sprite activities (spriteCreate / spriteExec /
// spriteCheckpoint / spriteRestore / spriteDestroy) — Sprites are a Fly product.
// They are runtime-orchestration primitives, not declarative resources; no App
// or Machine is deployed here. The base activities and the Op DSL are core's own
// and load with no lexicon listed. `chant run agent-task` resolves each step's
// `fn` against both tables.
export default { lexicons: ["fly"] } satisfies ChantConfig;
