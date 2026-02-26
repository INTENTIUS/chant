import { describe, test, expect } from "bun:test";
import { generateHelpers } from "./helpers";

describe("generateHelpers", () => {
  test("generates all standard named templates", () => {
    const content = generateHelpers({ chartName: "my-app" });

    expect(content).toContain('{{- define "my-app.name" -}}');
    expect(content).toContain('{{- define "my-app.fullname" -}}');
    expect(content).toContain('{{- define "my-app.chart" -}}');
    expect(content).toContain('{{- define "my-app.labels" -}}');
    expect(content).toContain('{{- define "my-app.selectorLabels" -}}');
    expect(content).toContain('{{- define "my-app.serviceAccountName" -}}');
  });

  test("fullname template handles nameOverride and fullnameOverride", () => {
    const content = generateHelpers({ chartName: "test" });

    expect(content).toContain(".Values.fullnameOverride");
    expect(content).toContain(".Values.nameOverride");
    expect(content).toContain("trunc 63");
    expect(content).toContain('trimSuffix "-"');
  });

  test("labels template includes standard Helm labels", () => {
    const content = generateHelpers({ chartName: "test" });

    expect(content).toContain("helm.sh/chart:");
    expect(content).toContain("app.kubernetes.io/version:");
    expect(content).toContain("app.kubernetes.io/managed-by:");
  });

  test("selectorLabels template has name and instance", () => {
    const content = generateHelpers({ chartName: "test" });

    expect(content).toContain("app.kubernetes.io/name:");
    expect(content).toContain("app.kubernetes.io/instance:");
  });

  test("serviceAccountName helper can be excluded", () => {
    const content = generateHelpers({ chartName: "test", includeServiceAccount: false });
    expect(content).not.toContain("serviceAccountName");
  });

  test("serviceAccountName helper included by default", () => {
    const content = generateHelpers({ chartName: "test" });
    expect(content).toContain("serviceAccountName");
    expect(content).toContain(".Values.serviceAccount.create");
    expect(content).toContain(".Values.serviceAccount.name");
  });
});
