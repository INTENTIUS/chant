import { describe, test, expect } from "vitest";
import {
  defaultLabels,
  defaultAnnotations,
  isDefaultLabels,
  isDefaultAnnotations,
  DEFAULT_LABELS_MARKER,
  DEFAULT_ANNOTATIONS_MARKER,
} from "./default-labels";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";

describe("defaultLabels", () => {
  test("returns object with correct markers", () => {
    const dl = defaultLabels({ env: "prod" });
    expect(dl[DEFAULT_LABELS_MARKER]).toBe(true);
    expect(dl[DECLARABLE_MARKER]).toBe(true);
  });

  test("has lexicon k8s", () => {
    const dl = defaultLabels({ env: "prod" });
    expect(dl.lexicon).toBe("k8s");
  });

  test("has correct entityType", () => {
    const dl = defaultLabels({ env: "prod" });
    expect(dl.entityType).toBe("chant:k8s:defaultLabels");
  });

  test("labels are accessible", () => {
    const dl = defaultLabels({ env: "prod", team: "backend" });
    expect(dl.labels.env).toBe("prod");
    expect(dl.labels.team).toBe("backend");
  });

  test("empty labels allowed", () => {
    const dl = defaultLabels({});
    expect(dl.labels).toEqual({});
  });
});

describe("defaultAnnotations", () => {
  test("returns object with correct markers", () => {
    const da = defaultAnnotations({ note: "hello" });
    expect(da[DEFAULT_ANNOTATIONS_MARKER]).toBe(true);
    expect(da[DECLARABLE_MARKER]).toBe(true);
  });

  test("has lexicon k8s", () => {
    const da = defaultAnnotations({ note: "hello" });
    expect(da.lexicon).toBe("k8s");
  });

  test("has correct entityType", () => {
    const da = defaultAnnotations({ note: "hello" });
    expect(da.entityType).toBe("chant:k8s:defaultAnnotations");
  });

  test("annotations are accessible", () => {
    const da = defaultAnnotations({ "kubernetes.io/description": "test" });
    expect(da.annotations["kubernetes.io/description"]).toBe("test");
  });

  test("empty annotations allowed", () => {
    const da = defaultAnnotations({});
    expect(da.annotations).toEqual({});
  });
});

describe("isDefaultLabels", () => {
  test("returns true for defaultLabels result", () => {
    expect(isDefaultLabels(defaultLabels({ env: "prod" }))).toBe(true);
  });

  test("returns false for null", () => {
    expect(isDefaultLabels(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isDefaultLabels(undefined)).toBe(false);
  });

  test("returns false for regular objects", () => {
    expect(isDefaultLabels({ labels: { env: "prod" } })).toBe(false);
  });

  test("returns false for defaultAnnotations", () => {
    expect(isDefaultLabels(defaultAnnotations({ note: "hi" }))).toBe(false);
  });
});

describe("isDefaultAnnotations", () => {
  test("returns true for defaultAnnotations result", () => {
    expect(isDefaultAnnotations(defaultAnnotations({ note: "hi" }))).toBe(true);
  });

  test("returns false for null", () => {
    expect(isDefaultAnnotations(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isDefaultAnnotations(undefined)).toBe(false);
  });

  test("returns false for regular objects", () => {
    expect(isDefaultAnnotations({ annotations: {} })).toBe(false);
  });

  test("returns false for defaultLabels", () => {
    expect(isDefaultAnnotations(defaultLabels({ env: "prod" }))).toBe(false);
  });
});
