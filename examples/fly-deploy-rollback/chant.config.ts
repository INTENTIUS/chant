import type { ChantConfig } from "@intentius/chant";

// Two lexicons compose the story:
//   fly       — the App/Machine resource types + the flaps applier (flyApply)
//               and the mudflaps lifecycle (flapsUp / flapsDown), plus the
//               Sprite activities (spriteCreate / spriteExec / spriteCheckpoint /
//               spriteRestore / spriteDestroy) and the spritzer lifecycle
//               (spritesUp / spritesDown) — Sprites are a Fly product too.
//   temporal  — the base activities (chantBuild, httpCheck) and the Op DSL.
// `chant run deploy` resolves each Op step's `fn` against these.
export default { lexicons: ["fly", "temporal"] } satisfies ChantConfig;
