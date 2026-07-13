import type { ChantConfig } from "@intentius/chant";

// The `fly` lexicon provides the Sprite activities this session composes:
// spriteCreate / spriteApplyNetworkPolicy / spriteTaskCreate / spriteWriteFile /
// spriteApplyServices / spriteExec / spriteTaskRelease / spriteDestroy. Sprites
// are runtime-orchestration primitives, not declarative resources, so no App or
// Machine is deployed here. The temporal base activities load automatically,
// supplying the Op DSL. `chant run managed-agent-session` resolves each step's
// `fn` from the fly lexicon.
export default { lexicons: ["fly"] } satisfies ChantConfig;
