import { describe, test, expect } from "vitest";
import { INTRINSIC_MARKER } from "@intentius/chant/intrinsic";
import {
  HelmTpl,
  HELM_TPL_KEY,
  HELM_IF_KEY,
  HELM_RANGE_KEY,
  HELM_WITH_KEY,
  values,
  Release,
  ChartRef,
  Capabilities,
  Template,
  filesGet,
  filesGlob,
  filesAsConfig,
  filesAsSecrets,
  ElseIf,
  include,
  required,
  helmDefault,
  toYaml,
  quote,
  printf,
  tpl,
  lookup,
  If,
  Range,
  With,
  withOrder,
  argoWave,
} from "./intrinsics";

describe("HelmTpl", () => {
  test("has INTRINSIC_MARKER", () => {
    const t = new HelmTpl("{{ .Values.x }}");
    expect(t[INTRINSIC_MARKER]).toBe(true);
  });

  test("toJSON returns __helm_tpl marker", () => {
    const t = new HelmTpl("{{ .Values.x }}");
    expect(t.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Values.x }}" });
  });

  test("pipe chains template functions", () => {
    const t = new HelmTpl("{{ .Values.x }}");
    const piped = t.pipe("upper");
    expect(piped.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Values.x | upper }}" });
  });

  test("multiple pipes chain correctly", () => {
    const t = new HelmTpl("{{ .Values.x }}");
    const piped = t.pipe("upper").pipe("quote");
    expect(piped.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Values.x | upper | quote }}" });
  });

  test("toString returns expression", () => {
    const t = new HelmTpl("{{ .Values.x }}");
    expect(t.toString()).toBe("{{ .Values.x }}");
  });
});

describe("values proxy", () => {
  test("simple property access", () => {
    const v = values.replicas;
    expect(v[INTRINSIC_MARKER]).toBe(true);
    expect(v.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Values.replicas }}" });
  });

  test("nested property access", () => {
    const v = values.image.repository;
    expect(v.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Values.image.repository }}" });
  });

  test("deeply nested access", () => {
    const v = values.a.b.c.d;
    expect(v.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Values.a.b.c.d }}" });
  });
});

describe("Release built-in", () => {
  test("Release.Name", () => {
    expect(Release.Name.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Release.Name }}" });
  });

  test("Release.Namespace", () => {
    expect(Release.Namespace.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Release.Namespace }}" });
  });

  test("Release.IsUpgrade", () => {
    expect(Release.IsUpgrade.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Release.IsUpgrade }}" });
  });
});

describe("ChartRef built-in", () => {
  test("ChartRef.Name", () => {
    expect(ChartRef.Name.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Chart.Name }}" });
  });

  test("ChartRef.Version", () => {
    expect(ChartRef.Version.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Chart.Version }}" });
  });

  test("ChartRef.Description", () => {
    expect(ChartRef.Description.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Chart.Description }}" });
  });

  test("ChartRef.Home", () => {
    expect(ChartRef.Home.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Chart.Home }}" });
  });

  test("ChartRef.KubeVersion", () => {
    expect(ChartRef.KubeVersion.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Chart.KubeVersion }}" });
  });
});

describe("template functions", () => {
  test("include", () => {
    const t = include("my-app.fullname");
    expect(t.toJSON()).toEqual({ [HELM_TPL_KEY]: '{{ include "my-app.fullname" . }}' });
  });

  test("include with custom context", () => {
    const t = include("my-app.labels", "$");
    expect(t.toJSON()).toEqual({ [HELM_TPL_KEY]: '{{ include "my-app.labels" $ }}' });
  });

  test("required", () => {
    const t = required("image.tag is required", values.image.tag);
    expect(t.toJSON()).toEqual({
      [HELM_TPL_KEY]: '{{ required "image.tag is required" .Values.image.tag }}',
    });
  });

  test("helmDefault", () => {
    const t = helmDefault("nginx", values.image.repository);
    expect(t.toJSON()).toEqual({
      [HELM_TPL_KEY]: '{{ default "nginx" .Values.image.repository }}',
    });
  });

  test("helmDefault with number", () => {
    const t = helmDefault(3, values.replicaCount);
    expect(t.toJSON()).toEqual({
      [HELM_TPL_KEY]: "{{ default 3 .Values.replicaCount }}",
    });
  });

  test("toYaml without indent", () => {
    const t = toYaml(values.resources);
    expect(t.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ toYaml .Values.resources }}" });
  });

  test("toYaml with indent", () => {
    const t = toYaml(values.resources, 12);
    expect(t.toJSON()).toEqual({
      [HELM_TPL_KEY]: "{{ toYaml .Values.resources | nindent 12 }}",
    });
  });

  test("quote", () => {
    const t = quote(values.image.tag);
    expect(t.toJSON()).toEqual({
      [HELM_TPL_KEY]: "{{ .Values.image.tag | quote }}",
    });
  });

  test("printf", () => {
    const t = printf("%s:%s", values.image.repository, values.image.tag);
    expect(t.toJSON()).toEqual({
      [HELM_TPL_KEY]: '{{ printf "%s:%s" .Values.image.repository .Values.image.tag }}',
    });
  });

  test("tpl", () => {
    const t = tpl(values.someTemplate);
    expect(t.toJSON()).toEqual({
      [HELM_TPL_KEY]: "{{ tpl .Values.someTemplate . }}",
    });
  });

  test("lookup", () => {
    const t = lookup("v1", "Secret", "default", "my-secret");
    expect(t.toJSON()).toEqual({
      [HELM_TPL_KEY]: '{{ lookup "v1" "Secret" "default" "my-secret" }}',
    });
  });
});

describe("control flow", () => {
  test("If produces __helm_if marker", () => {
    const cond = If(values.ingress.enabled, { key: "value" });
    const json = cond.toJSON();
    expect(json).toHaveProperty(HELM_IF_KEY);
    expect((json as Record<string, unknown>)[HELM_IF_KEY]).toBe(".Values.ingress.enabled");
    expect((json as Record<string, unknown>).body).toEqual({ key: "value" });
  });

  test("If with else", () => {
    const cond = If(values.enabled, "yes", "no");
    const json = cond.toJSON() as Record<string, unknown>;
    expect(json[HELM_IF_KEY]).toBe(".Values.enabled");
    expect(json.body).toBe("yes");
    expect(json.else).toBe("no");
  });

  test("Range produces __helm_range marker", () => {
    const r = Range(values.hosts, { host: "item" });
    const json = r.toJSON() as Record<string, unknown>;
    expect(json).toHaveProperty(HELM_RANGE_KEY);
    expect(json[HELM_RANGE_KEY]).toBe(".Values.hosts");
    expect(json.body).toEqual({ host: "item" });
  });

  test("With produces __helm_with marker", () => {
    const w = With(values.nodeSelector, { key: "value" });
    const json = w.toJSON() as Record<string, unknown>;
    expect(json).toHaveProperty(HELM_WITH_KEY);
    expect(json[HELM_WITH_KEY]).toBe(".Values.nodeSelector");
    expect(json.body).toEqual({ key: "value" });
  });

  test("If has INTRINSIC_MARKER", () => {
    const cond = If(values.x, "y");
    expect(cond[INTRINSIC_MARKER]).toBe(true);
  });

  test("If with string condition", () => {
    const cond = If(".Values.ingress.enabled", { enabled: true });
    const json = cond.toJSON() as Record<string, unknown>;
    expect(json[HELM_IF_KEY]).toBe(".Values.ingress.enabled");
  });

  test("Range has INTRINSIC_MARKER", () => {
    const r = Range(values.hosts, { host: "item" });
    expect(r[INTRINSIC_MARKER]).toBe(true);
  });

  test("With has INTRINSIC_MARKER", () => {
    const w = With(values.nodeSelector, {});
    expect(w[INTRINSIC_MARKER]).toBe(true);
  });
});

describe("Capabilities built-in", () => {
  test("Capabilities.KubeVersion.Version", () => {
    expect(Capabilities.KubeVersion.Version.toJSON()).toEqual({
      [HELM_TPL_KEY]: "{{ .Capabilities.KubeVersion.Version }}",
    });
  });

  test("Capabilities.APIVersions", () => {
    expect(Capabilities.APIVersions.toJSON()).toEqual({
      [HELM_TPL_KEY]: "{{ .Capabilities.APIVersions }}",
    });
  });

  test("Capabilities.HelmVersion.Version", () => {
    expect(Capabilities.HelmVersion.Version.toJSON()).toEqual({
      [HELM_TPL_KEY]: "{{ .Capabilities.HelmVersion.Version }}",
    });
  });

  test("has INTRINSIC_MARKER", () => {
    expect(Capabilities[INTRINSIC_MARKER]).toBe(true);
  });
});

describe("Template built-in", () => {
  test("Template.Name", () => {
    expect(Template.Name.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Template.Name }}" });
  });

  test("Template.BasePath", () => {
    expect(Template.BasePath.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Template.BasePath }}" });
  });
});

describe("Files helpers", () => {
  test("filesGet", () => {
    expect(filesGet("config.ini").toJSON()).toEqual({
      [HELM_TPL_KEY]: '{{ .Files.Get "config.ini" }}',
    });
  });

  test("filesGlob", () => {
    expect(filesGlob("conf/*").toJSON()).toEqual({
      [HELM_TPL_KEY]: '{{ .Files.Glob "conf/*" }}',
    });
  });

  test("filesAsConfig", () => {
    expect(filesAsConfig("conf/*").toJSON()).toEqual({
      [HELM_TPL_KEY]: '{{ (.Files.Glob "conf/*").AsConfig }}',
    });
  });

  test("filesAsSecrets", () => {
    expect(filesAsSecrets("secrets/*").toJSON()).toEqual({
      [HELM_TPL_KEY]: '{{ (.Files.Glob "secrets/*").AsSecrets }}',
    });
  });
});

describe("ElseIf", () => {
  test("produces __helm_if marker", () => {
    const ei = ElseIf(values.backup, "silver");
    const json = ei.toJSON() as Record<string, unknown>;
    expect(json[HELM_IF_KEY]).toBe(".Values.backup");
    expect(json.body).toBe("silver");
  });

  test("with else body", () => {
    const ei = ElseIf(values.backup, "silver", "bronze");
    const json = ei.toJSON() as Record<string, unknown>;
    expect(json[HELM_IF_KEY]).toBe(".Values.backup");
    expect(json.body).toBe("silver");
    expect(json.else).toBe("bronze");
  });

  test("with string condition", () => {
    const ei = ElseIf(".Values.x", "yes");
    const json = ei.toJSON() as Record<string, unknown>;
    expect(json[HELM_IF_KEY]).toBe(".Values.x");
  });
});

describe("values proxy pipe chaining", () => {
  test("single pipe on values proxy", () => {
    const v = (values.environment as any).pipe("upper");
    expect(v.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Values.environment | upper }}" });
  });

  test("double pipe on values proxy", () => {
    const v = (values.environment as any).pipe("upper").pipe("quote");
    expect(v.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Values.environment | upper | quote }}" });
  });

  test("triple pipe on values proxy", () => {
    const v = (values.x as any).pipe("lower").pipe("trimSuffix", ).pipe("quote");
    expect(v.toJSON()).toEqual({
      [HELM_TPL_KEY]: "{{ .Values.x | lower | trimSuffix | quote }}",
    });
  });

  test("pipe on nested values proxy", () => {
    const v = (values.image.tag as any).pipe("quote");
    expect(v.toJSON()).toEqual({ [HELM_TPL_KEY]: "{{ .Values.image.tag | quote }}" });
  });
});

describe("withOrder", () => {
  test("returns hook annotations with weight", () => {
    const annotations = withOrder(5);
    expect(annotations["helm.sh/hook"]).toBe("pre-install,pre-upgrade");
    expect(annotations["helm.sh/hook-weight"]).toBe("5");
  });

  test("handles negative weights", () => {
    const annotations = withOrder(-10);
    expect(annotations["helm.sh/hook-weight"]).toBe("-10");
  });

  test("handles zero weight", () => {
    const annotations = withOrder(0);
    expect(annotations["helm.sh/hook-weight"]).toBe("0");
  });
});

describe("argoWave", () => {
  test("returns sync wave annotation", () => {
    const annotations = argoWave(2);
    expect(annotations["argocd.argoproj.io/sync-wave"]).toBe("2");
  });

  test("handles negative waves", () => {
    const annotations = argoWave(-1);
    expect(annotations["argocd.argoproj.io/sync-wave"]).toBe("-1");
  });
});
