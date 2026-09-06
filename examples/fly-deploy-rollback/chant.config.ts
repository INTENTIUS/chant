import type { ChantConfig } from "@intentius/chant";

// One lexicon carries the story: `fly` — the App/Machine resource types + the
// flaps applier (flyApply) and the mudflaps lifecycle (flapsUp / flapsDown),
// plus the Sprite activities (spriteCreate / spriteExec / spriteCheckpoint /
// spriteRestore / spriteDestroy) and the spritzer lifecycle (spritesUp /
// spritesDown) — Sprites are a Fly product too. The base activities
// (chantBuild, httpCheck) and the Op DSL come from core, so nothing has to be
// listed for them. `chant run fly-deploy` resolves each Op step's `fn` against
// core's table plus this lexicon's.
export default { lexicons: ["fly"] } satisfies ChantConfig;
