import type { ChantConfig } from "@intentius/chant";
// `src/` holds a lint-only `chant.config.ts`. chant can't tell it apart from a
// project config without running it, so discovery treats `src/` as a child
// project unless `include` names it (#2527).
export default { lexicons: ["aws"], include: ["src"] } satisfies ChantConfig;
