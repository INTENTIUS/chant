/**
 * GCP pseudo-parameters in spec values are resolved at build, and a build
 * that can't resolve one refuses with the variable named (#4200).
 */

import { afterEach, describe, expect, test } from "vitest";
import { CloudRunServiceComposite } from "./composites/cloud-run-service";
import { gcpSerializer } from "./serializer";

const saved = { project: process.env.GCP_PROJECT_ID, region: process.env.GCP_REGION };
afterEach(() => {
  for (const [k, v] of [["GCP_PROJECT_ID", saved.project], ["GCP_REGION", saved.region]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function build(): string {
  const { service } = CloudRunServiceComposite({ name: "web", image: "traefik/whoami:v1.10", port: 80 });
  return gcpSerializer.serialize(new Map([["web", service]])) as string;
}

describe("gcp pseudo-parameters in spec values", () => {
  test("resolve from GCP_PROJECT_ID and GCP_REGION", () => {
    process.env.GCP_PROJECT_ID = "three-cloud";
    process.env.GCP_REGION = "asia-northeast1";
    const yaml = build();
    expect(yaml).toContain("location: asia-northeast1");
    expect(yaml).toContain("external: three-cloud");
    expect(yaml).not.toMatch(/Ref: GCP::/);
  });

  test("refuse the build, naming each unset variable", () => {
    delete process.env.GCP_PROJECT_ID;
    delete process.env.GCP_REGION;
    expect(build).toThrow(/GCP_REGION, GCP_PROJECT_ID are not set[\s\S]*web: GCP::Region needs GCP_REGION[\s\S]*web: GCP::ProjectId needs GCP_PROJECT_ID/);
  });
});
