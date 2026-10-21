/**
 * The live readers take a resource's project from `projectRef.external`
 * (#4201), the way `CloudRunServiceComposite` declares it, before
 * GOOGLE_CLOUD_PROJECT and the annotations.
 */

import { afterEach, describe, expect, test } from "vitest";
import { manifestProjectAnnotations, resolveReadProject } from "./describe-resources";

const saved = process.env.GOOGLE_CLOUD_PROJECT;
afterEach(() => {
  if (saved === undefined) delete process.env.GOOGLE_CLOUD_PROJECT;
  else process.env.GOOGLE_CLOUD_PROJECT = saved;
});

describe("resolveReadProject", () => {
  test("reads the entity's projectRef.external with no env or annotation", () => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    const props = { projectRef: { external: "three-cloud" }, location: "asia-northeast1" };
    expect(resolveReadProject("RunService", "web", { annotations: {} }, new Map(), props)).toBe("three-cloud");
  });

  test("still names every knob when nothing resolves", () => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
    expect(() => resolveReadProject("RunService", "web", undefined, new Map(), {})).toThrow(/projectRef\.external/);
  });
});

describe("manifestProjectAnnotations", () => {
  test("takes a document's spec.projectRef.external", () => {
    const yaml = `apiVersion: run.cnrm.cloud.google.com/v1beta1
kind: RunService
metadata:
  name: web
spec:
  projectRef:
    external: projects/three-cloud
`;
    expect(manifestProjectAnnotations(yaml).get("RunService/web")).toBe("three-cloud");
  });
});
