import type { ChantConfig } from "@intentius/chant";

// The root of chant's release workspace. Two things live here.
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
//
// The lockstep release (#4040), every package at one label: `release.publish`
// below. `just release` no longer cuts it. It stays so a lockstep release cut
// before the train can be published again on its release/npm/<label> tag
// (.github/workflows/publish-legacy.yml), until two trains have published
// (#5137). A publish never builds: scripts/release-pack.sh writes the
// tarballs named here, every package at the release's label, before the
// publish runs. The order is publish-packages.sh's dependency layers, core
// first, and release-member.test.ts checks it against them.
//
// stage: false publishes straight to latest. Moving a dist-tag over trusted
// publishing needs a per-package setting on npmjs.com that chant's records
// do not have (#3904). tokenEnv keeps publish-packages.sh's fallback: a
// package whose trusted-publisher record fails publishes with NPM_TOKEN.
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
      build: false,
      chant: "npx tsx ../packages/core/src/cli/main.ts",
      toolchains: ["node"],
      // #5223: each member's prepack compiles its workspace dependencies'
      // source, which imports their generated files. A resumed train skips a
      // dependency an earlier run published, so nothing else would generate
      // them: generate every lexicon after the install.
      setup: [{ run: "cd .. && npm run generate" }],
      env: {
        CHANT_RELEASE_GATE: "1",
        NPM_TOKEN: "${{ secrets.NPM_TOKEN }}",
      },
    },
    publish: [
      {
        type: "npm",
        access: "public",
        stage: false,
        tokenEnv: "NPM_TOKEN",
        packages: [
          "../.release/packs/packages_core.tgz",
          "../.release/packs/packages_k8s-client.tgz",
          "../.release/packs/lexicons_aws.tgz",
          "../.release/packs/lexicons_azure.tgz",
          "../.release/packs/lexicons_cedar.tgz",
          "../.release/packs/lexicons_cpln.tgz",
          "../.release/packs/lexicons_e2b.tgz",
          "../.release/packs/lexicons_fountain.tgz",
          "../.release/packs/lexicons_gcp.tgz",
          "../.release/packs/lexicons_github.tgz",
          "../.release/packs/lexicons_k3d.tgz",
          "../.release/packs/lexicons_k3s.tgz",
          "../.release/packs/lexicons_otel.tgz",
          "../.release/packs/lexicons_prow.tgz",
          "../.release/packs/lexicons_pulumi.tgz",
          "../.release/packs/lexicons_render.tgz",
          "../.release/packs/lexicons_sql.tgz",
          "../.release/packs/lexicons_terraform.tgz",
          "../.release/packs/lexicons_docker.tgz",
          "../.release/packs/lexicons_fly.tgz",
          "../.release/packs/lexicons_forgejo.tgz",
          "../.release/packs/lexicons_gitlab.tgz",
          "../.release/packs/lexicons_prometheus.tgz",
          "../.release/packs/lexicons_k8s.tgz",
          "../.release/packs/lexicons_grafana.tgz",
          "../.release/packs/lexicons_helm.tgz",
        ],
      },
    ],
  },
} satisfies ChantConfig;
