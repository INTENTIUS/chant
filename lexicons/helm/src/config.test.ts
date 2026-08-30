import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  helmConfigSchema,
  helmCapabilityProfileSchema,
  resolveCapabilityProfile,
  validateCapabilityProfile,
  KUBE_VERSION_PATTERN,
} from "./config";

describe("helmConfigSchema", () => {
  test("accepts a well-formed capabilityProfiles record", () => {
    const result = helmConfigSchema.safeParse({
      capabilityProfiles: {
        prod: { kubeVersion: "1.33.6", apiVersions: ["monitoring.coreos.com/v1"] },
        staging: { kubeVersion: "v1.31" },
      },
    });
    expect(result.success).toBe(true);
  });

  test("rejects a kubeVersion that is not version-shaped", () => {
    const result = helmCapabilityProfileSchema.safeParse({ kubeVersion: "latest" });
    expect(result.success).toBe(false);
  });

  test("rejects an empty apiVersions entry", () => {
    const result = helmCapabilityProfileSchema.safeParse({ kubeVersion: "1.33.6", apiVersions: [""] });
    expect(result.success).toBe(false);
  });

  test("rejects an unknown profile field (typo protection)", () => {
    const result = helmCapabilityProfileSchema.safeParse({ kubeVersion: "1.33.6", apiVersion: ["v1"] });
    expect(result.success).toBe(false);
  });

  test("KUBE_VERSION_PATTERN accepts the shapes --kube-version does", () => {
    for (const ok of ["1.33", "1.33.6", "v1.33.6", "v1.31"]) {
      expect(KUBE_VERSION_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of ["latest", "1", "one.two", "1.33.6-rc.1", ""]) {
      expect(KUBE_VERSION_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe("validateCapabilityProfile", () => {
  test("a sound profile has no errors", () => {
    expect(
      validateCapabilityProfile({ name: "prod", kubeVersion: "1.33.6", apiVersions: ["batch/v1"] }),
    ).toEqual([]);
  });

  test("errors name the profile and the offending field", () => {
    const errors = validateCapabilityProfile({ name: "prod", kubeVersion: "latest", apiVersions: [""] });
    expect(errors.length).toBe(2);
    expect(errors[0]).toContain('"prod"');
    expect(errors[0]).toContain("kubeVersion");
    expect(errors[1]).toContain("apiVersions");
  });

  test("a missing name is an error", () => {
    const errors = validateCapabilityProfile({ name: "", kubeVersion: "1.33.6" });
    expect(errors.some((e) => e.includes("name"))).toBe(true);
  });
});

describe("resolveCapabilityProfile", () => {
  test("an inline profile is validated and returned as-is", () => {
    const profile = { name: "prod", kubeVersion: "1.33.6", apiVersions: ["monitoring.coreos.com/v1"] };
    expect(resolveCapabilityProfile(profile)).toBe(profile);
  });

  test("an inline profile with a bad kubeVersion throws", () => {
    expect(() => resolveCapabilityProfile({ name: "prod", kubeVersion: "latest" })).toThrow(/kubeVersion/);
  });

  test("a name resolves against helm.capabilityProfiles in chant.config.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-helm-profile-test-"));
    try {
      writeFileSync(
        join(dir, "chant.config.json"),
        JSON.stringify({
          helm: {
            capabilityProfiles: {
              prod: { kubeVersion: "1.33.6", apiVersions: ["monitoring.coreos.com/v1"] },
            },
          },
        }),
      );
      const profile = resolveCapabilityProfile("prod", { startDir: dir });
      expect(profile).toEqual({
        name: "prod",
        kubeVersion: "1.33.6",
        apiVersions: ["monitoring.coreos.com/v1"],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an undeclared name throws, naming the profile and the declared ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-helm-profile-test-"));
    try {
      writeFileSync(
        join(dir, "chant.config.json"),
        JSON.stringify({ helm: { capabilityProfiles: { staging: { kubeVersion: "1.31.4" } } } }),
      );
      expect(() => resolveCapabilityProfile("prod", { startDir: dir })).toThrow(
        /capability profile "prod" is not declared.*staging/s,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a name with no config at all throws, naming the profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-helm-profile-test-"));
    try {
      expect(() => resolveCapabilityProfile("prod", { startDir: dir })).toThrow(
        /capability profile "prod" is not declared/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
