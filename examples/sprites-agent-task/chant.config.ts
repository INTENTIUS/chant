import type { ChantConfig } from "@intentius/chant";

// The temporal base activities are enough: sprite activities live there
// (spriteCreate / spriteExec / spriteCheckpoint / spriteRestore / spriteDestroy).
// No cloud lexicon — Sprites are runtime-orchestration primitives, not
// declarative resources. `chant run agent-task` resolves each step's `fn` here.
export default { lexicons: ["temporal"] } satisfies ChantConfig;
