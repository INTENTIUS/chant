import type { ChantConfig } from "@intentius/chant";

// The root of chant's release workspace, which declares the release train.
//
// The release train (#5154): each publishable package is its own release
// member under release/<member>/, and `release.train` releases every member
// that changed as one train. `chant release workflow`, run here, writes
// .github/workflows/publish.yml from `release.workflow`: dispatched with the
// levels (`just release`), it picks the newest green main commit, runs
// `chant workspace train cut npm`, and publishes the train core first with
// `chant workspace train prepare` and `train publish`. The file keeps the
// name the 25 npm trusted-publisher records name. The first train cuts every
// member at one label past every version any package has (first:
// "together"), and `check` refuses a train whose core floors name a version
// that is neither released nor core's label (#4480). legacyTags are the tags
// of the releases before the train, read as each member's last release.

export default {
  environments: ["npm"],
  release: {
    legacyTags: ["release/npm/", "chant-v"],
    train: {
      env: "npm",
      first: "together",
      check: ["npx tsx ../scripts/release-floors.ts --npm --rev \"$CHANT_RELEASE_COMMIT\" --train-plan \"$CHANT_TRAIN_PLAN\""],
    },
    workflow: {
      trigger: "dispatch",
      file: ".github/workflows/publish.yml",
      install: "cd .. && npm ci",
      // No build step: each member's prepack builds it, and train prepare
      // builds a package that a member still to publish compiles against
      // when this train does not pack it (#5222).
      build: false,
      chant: "npx tsx ../packages/core/src/cli/main.ts",
      toolchains: ["node"],
      // #5216: no release doctor before the train's cut. A package whose npm
      // trusted-publisher record fails publishes with NPM_TOKEN (each member's
      // tokenEnv), and the doctor's trusted-publisher check would stop the train
      // for it before that fallback is reached.
      doctor: false,
      env: {
        CHANT_RELEASE_GATE: "1",
        NPM_TOKEN: "${{ secrets.NPM_TOKEN }}",
      },
    },
  },
} satisfies ChantConfig;
