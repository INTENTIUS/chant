import type { ChantConfig } from "@intentius/chant";

// Two lexicons compose the story:
//   fly       — the App/Machine resource types + the flaps applier (flyApply)
//               and the mudflaps lifecycle (flapsUp / flapsDown).
//   temporal  — the base activities (chantBuild, httpCheck) and the Sprite
//               activities (spriteCreate / spriteExec / spriteCheckpoint /
//               spriteRestore / spriteDestroy) plus the spritzer lifecycle
//               (spritesUp / spritesDown).
// `chant run agent-deploy` resolves each Op step's `fn` against these.
export default { lexicons: ["fly", "temporal"] } satisfies ChantConfig;
