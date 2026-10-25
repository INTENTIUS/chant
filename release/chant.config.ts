import type { ChantConfig } from "@intentius/chant";

// chant's own npm release (#4040). `just release` cuts it with
// `chant release cut --at <green sha>`, and publish.yml publishes it on the
// release/npm/<label> tag with `chant release publish`.
//
// A publish never builds. scripts/release-pack.sh writes the tarballs named
// here, every package at the release's label, before the publish runs. The
// order is publish-packages.sh's dependency layers, core first, and
// release-member.test.ts checks it against them.
//
// stage: false publishes straight to latest. Moving a dist-tag over trusted
// publishing needs a per-package setting on npmjs.com that chant's records
// do not have (#3904). tokenEnv keeps publish-packages.sh's fallback: a
// package whose trusted-publisher record fails publishes with NPM_TOKEN.
export default {
  environments: ["npm"],
  release: {
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
