import { describe, test, expect } from "vitest";
import { applyConfigDefaults } from "./config-defaults";
import type { DriverComponent } from "./driver";
import type { ChantConfig } from "../config";

function component(deploy: DriverComponent["deploy"]): DriverComponent {
  return { name: "svc", dependsOn: [], deploy };
}

describe("applyConfigDefaults", () => {
  test("generate-sbom: picks up sbom.format from config when the step omits it", () => {
    const config: ChantConfig = { sbom: { format: "cyclonedx" } };
    const comp = component([
      { phase: "Build", steps: [{ kind: "generate-sbom", artifactType: "image", path: "img" }] },
    ]);

    const result = applyConfigDefaults(comp, config);
    const step = result.deploy[0]!.steps[0] as { format?: string };
    expect(step.format).toBe("cyclonedx");
  });

  test("generate-sbom: a step's own format overrides config", () => {
    const config: ChantConfig = { sbom: { format: "cyclonedx" } };
    const comp = component([
      { phase: "Build", steps: [{ kind: "generate-sbom", artifactType: "image", path: "img", format: "spdx" }] },
    ]);

    const result = applyConfigDefaults(comp, config);
    const step = result.deploy[0]!.steps[0] as { format?: string };
    expect(step.format).toBe("spdx");
  });

  test("generate-sbom: falls back to DEFAULT_SBOM_FORMAT when neither step nor config sets it", () => {
    const config: ChantConfig = {};
    const comp = component([
      { phase: "Build", steps: [{ kind: "generate-sbom", artifactType: "image", path: "img" }] },
    ]);

    const result = applyConfigDefaults(comp, config);
    const step = result.deploy[0]!.steps[0] as { format?: string };
    expect(step.format).toBe("spdx");
  });

  test("sign: fills keyless oidcIssuer from config's signing.oidcIssuer", () => {
    const config: ChantConfig = { signing: { oidcIssuer: "https://token.actions.githubusercontent.com" } };
    const comp = component([
      { phase: "Publish", steps: [{ kind: "sign", imageRef: "repo@sha256:abc" }] },
    ]);

    const result = applyConfigDefaults(comp, config);
    const step = result.deploy[0]!.steps[0] as { keyless?: { oidcIssuer?: string } };
    expect(step.keyless?.oidcIssuer).toBe("https://token.actions.githubusercontent.com");
  });

  test("sign: a step's own keyless config is left untouched", () => {
    const config: ChantConfig = { signing: { oidcIssuer: "https://token.actions.githubusercontent.com" } };
    const comp = component([
      {
        phase: "Publish",
        steps: [{ kind: "sign", imageRef: "repo@sha256:abc", keyless: { oidcIssuer: "https://custom.example.com" } }],
      },
    ]);

    const result = applyConfigDefaults(comp, config);
    const step = result.deploy[0]!.steps[0] as { keyless?: { oidcIssuer?: string } };
    expect(step.keyless?.oidcIssuer).toBe("https://custom.example.com");
  });

  test("sign: a step's own key opts out of config keyless defaults entirely", () => {
    const config: ChantConfig = { signing: { oidcIssuer: "https://token.actions.githubusercontent.com" } };
    const comp = component([
      { phase: "Publish", steps: [{ kind: "sign", imageRef: "repo@sha256:abc", key: { key: "kms://my-key" } }] },
    ]);

    const result = applyConfigDefaults(comp, config);
    const step = result.deploy[0]!.steps[0] as { key?: { key: string }; keyless?: unknown };
    expect(step.key).toEqual({ key: "kms://my-key" });
    expect(step.keyless).toBeUndefined();
  });

  test("sign: config's key-based override (keyless: false + key) fills the step's key", () => {
    const config: ChantConfig = { signing: { keyless: false, key: "kms://project-key" } };
    const comp = component([
      { phase: "Publish", steps: [{ kind: "sign", imageRef: "repo@sha256:abc" }] },
    ]);

    const result = applyConfigDefaults(comp, config);
    const step = result.deploy[0]!.steps[0] as { key?: { key: string } };
    expect(step.key).toEqual({ key: "kms://project-key" });
  });

  test("attest-provenance: also picks up the configured oidcIssuer", () => {
    const config: ChantConfig = { signing: { oidcIssuer: "https://token.actions.githubusercontent.com" } };
    const comp = component([
      {
        phase: "Publish",
        steps: [{
          kind: "attest-provenance",
          imageRef: "repo@sha256:abc",
          provenance: { sourceRef: "git@abc", artifactDigest: "sha256:abc" },
          builderId: "https://github.com/actions/runner",
        }],
      },
    ]);

    const result = applyConfigDefaults(comp, config);
    const step = result.deploy[0]!.steps[0] as { keyless?: { oidcIssuer?: string } };
    expect(step.keyless?.oidcIssuer).toBe("https://token.actions.githubusercontent.com");
  });

  test("verify: fills expectedIssuer/expectedIdentity from config's signing section without repeating them per-step", () => {
    const config: ChantConfig = {
      signing: {
        oidcIssuer: "https://token.actions.githubusercontent.com",
        identity: "https://github.com/acme/repo/.github/workflows/release.yml@refs/heads/main",
      },
    };
    const comp = component([
      { phase: "Verify", steps: [{ kind: "verify", imageRef: "repo@sha256:abc", policy: {} }] },
    ]);

    const result = applyConfigDefaults(comp, config);
    const step = result.deploy[0]!.steps[0] as {
      policy?: { expectedIssuer?: string; expectedIdentity?: string };
    };
    expect(step.policy?.expectedIssuer).toBe("https://token.actions.githubusercontent.com");
    expect(step.policy?.expectedIdentity).toBe(
      "https://github.com/acme/repo/.github/workflows/release.yml@refs/heads/main",
    );
  });

  test("verify: a per-step policy value overrides config", () => {
    const config: ChantConfig = {
      signing: {
        oidcIssuer: "https://token.actions.githubusercontent.com",
        identity: "https://github.com/acme/repo/.github/workflows/release.yml@refs/heads/main",
      },
    };
    const comp = component([
      {
        phase: "Verify",
        steps: [{
          kind: "verify",
          imageRef: "repo@sha256:abc",
          policy: { expectedIssuer: "https://custom-issuer.example.com" },
        }],
      },
    ]);

    const result = applyConfigDefaults(comp, config);
    const step = result.deploy[0]!.steps[0] as { policy?: { expectedIssuer?: string; expectedIdentity?: string } };
    expect(step.policy?.expectedIssuer).toBe("https://custom-issuer.example.com");
    // Untouched field still fills from config.
    expect(step.policy?.expectedIdentity).toBe(
      "https://github.com/acme/repo/.github/workflows/release.yml@refs/heads/main",
    );
  });

  test("verify: a step with no policy field at all still gets one filled from config", () => {
    const config: ChantConfig = { signing: { oidcIssuer: "https://issuer.example.com", identity: "id" } };
    const comp = component([
      { phase: "Verify", steps: [{ kind: "verify", imageRef: "repo@sha256:abc" }] },
    ]);

    const result = applyConfigDefaults(comp, config);
    const step = result.deploy[0]!.steps[0] as { policy?: { expectedIssuer?: string } };
    expect(step.policy?.expectedIssuer).toBe("https://issuer.example.com");
  });

  test("vuln-gate: a vulnPolicy in config changes the step's effective policy", () => {
    const config: ChantConfig = { vulnPolicy: { failSeverity: "high", warnSeverity: "medium" } };
    const comp = component([
      { phase: "Gate", steps: [{ kind: "vuln-gate", sbom: { bytes: "", mediaType: "", packageCount: 0, generator: "x", format: "spdx" } }] },
    ]);

    const result = applyConfigDefaults(comp, config);
    const step = result.deploy[0]!.steps[0] as { policy?: { failSeverity?: string; warnSeverity?: string } };
    expect(step.policy?.failSeverity).toBe("high");
    expect(step.policy?.warnSeverity).toBe("medium");
  });

  test("vuln-gate: the step's own policy field wins over config for that field", () => {
    const config: ChantConfig = { vulnPolicy: { failSeverity: "high", warnSeverity: "medium" } };
    const comp = component([
      {
        phase: "Gate",
        steps: [{
          kind: "vuln-gate",
          sbom: { bytes: "", mediaType: "", packageCount: 0, generator: "x", format: "spdx" },
          policy: { failSeverity: "critical" },
        }],
      },
    ]);

    const result = applyConfigDefaults(comp, config);
    const step = result.deploy[0]!.steps[0] as { policy?: { failSeverity?: string; warnSeverity?: string } };
    // Step wins on the field it set...
    expect(step.policy?.failSeverity).toBe("critical");
    // ...but config still fills the field the step left unset.
    expect(step.policy?.warnSeverity).toBe("medium");
  });

  test("recurses into nested fan-out phases and onFailure compensation phases", () => {
    const config: ChantConfig = { sbom: { format: "cyclonedx" } };
    const comp = component([
      {
        phase: "Rollout",
        steps: [
          {
            phase: "instance-1",
            steps: [{ kind: "generate-sbom", artifactType: "image", path: "img" }],
          },
        ],
        onFailure: [
          { phase: "Compensate", steps: [{ kind: "generate-sbom", artifactType: "image", path: "img2" }] },
        ],
      },
    ]);

    const result = applyConfigDefaults(comp, config);
    const nested = result.deploy[0]!.steps[0] as { steps: Array<{ format?: string }> };
    expect(nested.steps[0]!.format).toBe("cyclonedx");
    const compensated = result.deploy[0]!.onFailure![0]!.steps[0] as { format?: string };
    expect(compensated.format).toBe("cyclonedx");
  });

  test("leaves gate steps untouched", () => {
    const config: ChantConfig = { sbom: { format: "cyclonedx" } };
    const comp = component([
      { phase: "Approve", steps: [{ kind: "gate", signalName: "release-approval" }] },
    ]);

    const result = applyConfigDefaults(comp, config);
    expect(result.deploy[0]!.steps[0]).toEqual({ kind: "gate", signalName: "release-approval" });
  });

  test("applies defaults to rollback phases too", () => {
    const config: ChantConfig = { vulnPolicy: { failSeverity: "high" } };
    const comp: DriverComponent = {
      name: "svc",
      dependsOn: [],
      deploy: [{ phase: "Apply", steps: [{ kind: "deploy-thing" }] }],
      rollback: [
        { phase: "Rollback", steps: [{ kind: "vuln-gate", sbom: { bytes: "", mediaType: "", packageCount: 0, generator: "x", format: "spdx" } }] },
      ],
    };

    const result = applyConfigDefaults(comp, config);
    const step = result.rollback![0]!.steps[0] as { policy?: { failSeverity?: string } };
    expect(step.policy?.failSeverity).toBe("high");
  });

  test("does not mutate the original component", () => {
    const config: ChantConfig = { sbom: { format: "cyclonedx" } };
    const comp = component([
      { phase: "Build", steps: [{ kind: "generate-sbom", artifactType: "image", path: "img" }] },
    ]);

    applyConfigDefaults(comp, config);
    const original = comp.deploy[0]!.steps[0] as { format?: string };
    expect(original.format).toBeUndefined();
  });
});
