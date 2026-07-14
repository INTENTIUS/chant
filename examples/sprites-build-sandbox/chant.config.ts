import type { ChantConfig } from "@intentius/chant";

// The `fly` lexicon provides the sprite activities (spriteCreate / spriteExec /
// spriteCheckpoint / spriteRestore / spriteDestroy) — Sprites are a Fly product.
// They are runtime-orchestration primitives, not declarative resources; no App
// or Machine is deployed here. The temporal base activities load automatically,
// supplying the Op DSL. `chant run agent-task` resolves each step's `fn` here.
export default { lexicons: ["fly"] } satisfies ChantConfig;
