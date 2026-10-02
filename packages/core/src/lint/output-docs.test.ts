import { describe, test, expect } from "vitest";
import { parseOutputDocs, pick, get } from "./output-docs";
import type { SerializerResult } from "../serializer";
import { load as jsYamlLoad } from "js-yaml";

describe("parseOutputDocs", () => {
  test("parses a single JSON output as one document", () => {
    const outputs = new Map<string, string | SerializerResult>([
      ["aws", JSON.stringify({ AWSTemplateFormatVersion: "2010-09-09", Resources: {} })],
    ]);
    const docs = parseOutputDocs(outputs);
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      lexicon: "aws",
      index: 0,
      format: "json",
    });
    expect(docs[0].error).toBeUndefined();
    expect((docs[0].value as { Resources: unknown }).Resources).toEqual({});
  });

  test("splits multi-document YAML on `---` into one OutputDoc per document", () => {
    const yaml = [
      "apiVersion: v1",
      "kind: Namespace",
      "metadata:",
      "  name: ns-a",
      "---",
      "apiVersion: apps/v1",
      "kind: Deployment",
      "metadata:",
      "  name: web",
    ].join("\n");
    const outputs = new Map<string, string | SerializerResult>([["k8s", yaml]]);
    const docs = parseOutputDocs(outputs);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ lexicon: "k8s", index: 0, format: "yaml" });
    expect(docs[1]).toMatchObject({ lexicon: "k8s", index: 1, format: "yaml" });
    expect((docs[0].value as { kind: string }).kind).toBe("Namespace");
    expect((docs[1].value as { kind: string }).kind).toBe("Deployment");
  });

  test("handles a leading `---` document separator before any content", () => {
    const yaml = ["---", "kind: Namespace", "---", "kind: Deployment"].join("\n");
    const outputs = new Map<string, string | SerializerResult>([["k8s", yaml]]);
    const docs = parseOutputDocs(outputs);
    expect(docs).toHaveLength(2);
    expect((docs[0].value as { kind: string }).kind).toBe("Namespace");
    expect((docs[1].value as { kind: string }).kind).toBe("Deployment");
  });

  test("drops empty documents between/around separators without erroring", () => {
    const yaml = ["---", "", "---", "kind: Deployment", "---", ""].join("\n");
    const outputs = new Map<string, string | SerializerResult>([["k8s", yaml]]);
    const docs = parseOutputDocs(outputs);
    expect(docs).toHaveLength(1);
    expect((docs[0].value as { kind: string }).kind).toBe("Deployment");
  });

  test("parses SerializerResult.files as additional, separately-indexed documents", () => {
    const output: SerializerResult = {
      primary: JSON.stringify({ kind: "root" }),
      files: {
        "nested.template.json": JSON.stringify({ kind: "nested-a" }),
        "sidecar.yaml": "kind: nested-b\n---\nkind: nested-c",
      },
    };
    const outputs = new Map<string, string | SerializerResult>([["aws", output]]);
    const docs = parseOutputDocs(outputs);

    const primaryDocs = docs.filter((d) => d.file === undefined);
    expect(primaryDocs).toHaveLength(1);
    expect((primaryDocs[0].value as { kind: string }).kind).toBe("root");

    const nestedJson = docs.filter((d) => d.file === "nested.template.json");
    expect(nestedJson).toHaveLength(1);
    expect((nestedJson[0].value as { kind: string }).kind).toBe("nested-a");

    // The sidecar YAML file is itself multi-document — index resets to 0
    // within that file, since index is scoped to its own source.
    const sidecarDocs = docs.filter((d) => d.file === "sidecar.yaml");
    expect(sidecarDocs).toHaveLength(2);
    expect(sidecarDocs[0].index).toBe(0);
    expect(sidecarDocs[1].index).toBe(1);
    expect((sidecarDocs[0].value as { kind: string }).kind).toBe("nested-b");
    expect((sidecarDocs[1].value as { kind: string }).kind).toBe("nested-c");

    expect(docs.every((d) => d.lexicon === "aws")).toBe(true);
  });

  test("skips a source with no files entries and no primary content", () => {
    const outputs = new Map<string, string | SerializerResult>([["empty", ""]]);
    expect(parseOutputDocs(outputs)).toEqual([]);
  });

  test("parses every ctx.outputs entry, tagging each with its own lexicon key", () => {
    const outputs = new Map<string, string | SerializerResult>([
      ["aws", JSON.stringify({ kind: "aws-thing" })],
      ["k8s", "kind: k8s-thing"],
    ]);
    const docs = parseOutputDocs(outputs);
    expect(docs.map((d) => d.lexicon).sort()).toEqual(["aws", "k8s"]);
  });

  describe("malformed documents — marker, not throw", () => {
    test("a bare scalar document is marked with an error instead of being treated as a manifest", () => {
      // "42" is syntactically fine (valid YAML/JSON) but is a scalar, not an
      // object/array — not something a manifest-shaped check can walk.
      const yaml = ["kind: Deployment", "---", "42", "---", "kind: Service"].join("\n");
      const outputs = new Map<string, string | SerializerResult>([["k8s", yaml]]);
      const docs = parseOutputDocs(outputs);

      expect(docs).toHaveLength(3);
      expect(docs[0].error).toBeUndefined();
      expect(docs[2].error).toBeUndefined();

      // The malformed middle document is a marker: present, flagged, no value.
      expect(docs[1].error).toBeDefined();
      expect(docs[1].value).toBeUndefined();
      expect(docs[1].format).toBe("yaml");

      // Filtering it out is one line, and leaves the good documents intact.
      const usable = docs.filter((d) => !d.error);
      expect(usable).toHaveLength(2);
      expect((usable[0].value as { kind: string }).kind).toBe("Deployment");
      expect((usable[1].value as { kind: string }).kind).toBe("Service");
    });

    test("a lone scalar as the entire output is marked with an error, not thrown", () => {
      // Valid JSON ("true" parses fine) but not an object/array — the
      // whole-content JSON path hits the same isUsableDoc guard.
      const outputs = new Map<string, string | SerializerResult>([["weird", "true"]]);
      expect(() => parseOutputDocs(outputs)).not.toThrow();
      const docs = parseOutputDocs(outputs);
      expect(docs).toHaveLength(1);
      expect(docs[0].format).toBe("json");
      expect(docs[0].error).toBeDefined();
      expect(docs[0].value).toBeUndefined();
    });

    test("a malformed document in one files entry does not affect the others", () => {
      const output: SerializerResult = {
        primary: "kind: root",
        files: {
          "good.yaml": "kind: good",
          "bad.yaml": "null",
        },
      };
      const outputs = new Map<string, string | SerializerResult>([["k8s", output]]);
      const docs = parseOutputDocs(outputs);

      const good = docs.find((d) => d.file === "good.yaml")!;
      const bad = docs.find((d) => d.file === "bad.yaml")!;
      expect(good.error).toBeUndefined();
      expect((good.value as { kind: string }).kind).toBe("good");
      expect(bad.error).toBeDefined();
      expect(bad.value).toBeUndefined();
    });
  });

  // #2925: hand-written and third-party YAML (`chant audit`, test fixtures)
  // uses flow collections and folded scalars. Each case is checked against
  // js-yaml, so the expected value is what a full parser reads.
  describe("YAML a hand-written manifest uses (#2925)", () => {
    const docOf = (yaml: string): unknown => {
      const docs = parseOutputDocs(new Map<string, string | SerializerResult>([["k8s", yaml]]));
      expect(docs).toHaveLength(1);
      expect(docs[0].error).toBeUndefined();
      return docs[0].value;
    };

    test("flow mappings read as mappings, not strings", () => {
      const yaml = [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata: { name: gw, namespace: obs }",
        "spec:",
        "  template:",
        "    spec:",
        "      volumes:",
        "        - name: conf",
        "          configMap: { name: gw-config }",
      ].join("\n");
      const value = docOf(yaml);
      expect(value).toEqual(jsYamlLoad(yaml));
      expect(get(value, "metadata.namespace")).toBe("obs");
      expect(get(value, "spec.template.spec.volumes.0.configMap.name")).toBe("gw-config");
    });

    test("a flow sequence of flow mappings reads as a list of mappings", () => {
      const yaml = [
        "kind: Pod",
        "spec:",
        "  containers:",
        "    - name: gw",
        "      volumeMounts: [{ name: conf, mountPath: /conf }, { name: data, mountPath: /data, readOnly: true }]",
        "      args: [--config, /conf/config.yaml]",
      ].join("\n");
      const value = docOf(yaml);
      expect(value).toEqual(jsYamlLoad(yaml));
      expect(get(value, "spec.containers.0.volumeMounts.1.readOnly")).toBe(true);
      expect(get(value, "spec.containers.0.args")).toEqual(["--config", "/conf/config.yaml"]);
    });

    test("a folded scalar keeps the line breaks of its more-indented lines", () => {
      // js-yaml dumps a long ConfigMap value this way.
      const yaml = [
        "kind: ConfigMap",
        "data:",
        "  config.yaml: >",
        "    receivers:",
        "      k8s_cluster:",
        "        auth_type: serviceAccount",
        "    exporters: {}",
      ].join("\n");
      const value = docOf(yaml);
      expect(value).toEqual(jsYamlLoad(yaml));
      expect((value as { data: Record<string, string> }).data["config.yaml"]).toBe(
        "receivers:\n  k8s_cluster:\n    auth_type: serviceAccount\nexporters: {}\n",
      );
    });
  });
});
