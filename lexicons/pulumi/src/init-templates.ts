/**
 * `chant init --lexicon pulumi` templates (#4510).
 *
 * The lexicon declares no resources, so a template never writes a Pulumi
 * program. Each one writes a chant project beside an existing program, which
 * the templates expect in `./infra` (the directory that holds `Pulumi.yaml`
 * and the checked-in `stack-export.json`); change `dir` if yours is
 * elsewhere.
 *
 * - `member` (the default): `chant.config.ts` reads the member's graph into
 *   the project's own build, so `chant build` and `chant lint` run PUL001 to
 *   PUL015 against its export. `src/` declares nothing.
 * - `watch`: the same, plus `src/watch.op.ts`, a `PulumiWatchOp` that
 *   previews the member and reads its drift every morning. It never applies.
 * - `plunge`: the watch for a member on plunge, with `engine: "plunge"` on
 *   both the member read and the Op, so drift is `plunge drift --stream`.
 *
 * Each ships its own `chant.config.ts` (`root`), which `chant init` writes in
 * place of its generic one.
 */
import type { InitTemplateSet } from "@intentius/chant/lexicon";

function chantConfig(member: string): string {
  return `import type { ChantConfig } from "@intentius/chant/config";
import "@intentius/chant-lexicon-pulumi";

/**
 * Reads the Pulumi program in ./infra as a member. Its graph is the stack
 * export that chant's pulumi-up apply writes to refs/chant/snapshots after
 * each update, so nothing is checked in. A stack applied outside chant can
 * check in stack-export.json beside Pulumi.yaml instead, taken with
 * \`pulumi stack export --file stack-export.json\` after each update.
 * \`dir\` is relative to this file (PUL101 warns on an absolute one).
 */
export default {
  lexicons: ["pulumi"],
  pulumi: {
    member: ${member},
  },
} satisfies ChantConfig;
`;
}

const NOTHING_DECLARED = `/**
 * Nothing is declared here. The Pulumi program in ./infra stays the source of
 * truth and \`pulumi up\` still applies it; chant.config.ts reads its checked-in
 * stack export into this build.
 */
export {};
`;

function watchOp(engine?: "plunge"): string {
  return `import { PulumiWatchOp } from "@intentius/chant-lexicon-pulumi";

/**
 * Preview the infra member and read its drift every morning at 06:00.
 * The run's outcomes are \`Changes\` (the preview plans something) and
 * \`Drift\` (resources drifted or missing). It changes nothing.
 * Run it once with \`chant run infra-watch\`.
 */
export const { op } = PulumiWatchOp({
  name: "infra-watch",
  member: "infra",
  dir: "./infra",${engine ? `\n  engine: "${engine}",` : ""}
  schedule: "0 6 * * *",
});

export default op;
`;
}

export const pulumiInitTemplates: Record<"member" | "watch" | "plunge", InitTemplateSet> = {
  member: {
    src: { "infra.ts": NOTHING_DECLARED },
    root: { "chant.config.ts": chantConfig(`{ dir: "./infra", label: "infra" }`) },
  },
  watch: {
    src: { "infra.ts": NOTHING_DECLARED, "watch.op.ts": watchOp() },
    root: { "chant.config.ts": chantConfig(`{ dir: "./infra", label: "infra" }`) },
  },
  plunge: {
    src: { "infra.ts": NOTHING_DECLARED, "watch.op.ts": watchOp("plunge") },
    root: { "chant.config.ts": chantConfig(`{ dir: "./infra", label: "infra", engine: "plunge" }`) },
  },
};
