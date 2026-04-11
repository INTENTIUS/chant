import { describe, test, expect } from "vitest";
import {
  DEFAULT_LABELS_MARKER,
  DEFAULT_ANNOTATIONS_MARKER,
  defaultLabels,
  defaultAnnotations,
  isDefaultLabels,
  isDefaultAnnotations,
} from "./default-labels";

describe("DEFAULT_LABELS_MARKER", () => {
  test("is a well-known symbol", () => {
    expect(typeof DEFAULT_LABELS_MARKER).toBe("symbol");
    expect(DEFAULT_LABELS_MARKER.toString()).toContain("docker.defaultLabels");
  });
});

describe("DEFAULT_ANNOTATIONS_MARKER", () => {
  test("is a well-known symbol", () => {
    expect(typeof DEFAULT_ANNOTATIONS_MARKER).toBe("symbol");
    expect(DEFAULT_ANNOTATIONS_MARKER.toString()).toContain("docker.defaultAnnotations");
  });
});

describe("defaultLabels", () => {
  test("creates a DefaultLabels entity", () => {
    const labels = { "app.team": "platform", "app.managed-by": "chant" };
    const entity = defaultLabels(labels);

    expect(entity.lexicon).toBe("docker");
    expect(entity.entityType).toBe("Docker::DefaultLabels");
    expect(entity.props.labels).toEqual(labels);
  });

  test("has DEFAULT_LABELS_MARKER", () => {
    const entity = defaultLabels({ "x": "y" });
    expect(DEFAULT_LABELS_MARKER in entity).toBe(true);
  });
});

describe("defaultAnnotations", () => {
  test("creates a DefaultAnnotations entity", () => {
    const annotations = { "app.version": "1.0.0" };
    const entity = defaultAnnotations(annotations);

    expect(entity.lexicon).toBe("docker");
    expect(entity.entityType).toBe("Docker::DefaultAnnotations");
    expect(entity.props.annotations).toEqual(annotations);
  });

  test("has DEFAULT_ANNOTATIONS_MARKER", () => {
    const entity = defaultAnnotations({ "x": "y" });
    expect(DEFAULT_ANNOTATIONS_MARKER in entity).toBe(true);
  });
});

describe("isDefaultLabels", () => {
  test("returns true for defaultLabels entity", () => {
    const entity = defaultLabels({ "x": "y" });
    expect(isDefaultLabels(entity)).toBe(true);
  });

  test("returns false for plain objects", () => {
    expect(isDefaultLabels({})).toBe(false);
    expect(isDefaultLabels(null)).toBe(false);
    expect(isDefaultLabels("string")).toBe(false);
  });
});

describe("isDefaultAnnotations", () => {
  test("returns true for defaultAnnotations entity", () => {
    const entity = defaultAnnotations({ "x": "y" });
    expect(isDefaultAnnotations(entity)).toBe(true);
  });

  test("returns false for defaultLabels", () => {
    const entity = defaultLabels({ "x": "y" });
    expect(isDefaultAnnotations(entity)).toBe(false);
  });

  test("returns false for plain objects", () => {
    expect(isDefaultAnnotations({})).toBe(false);
    expect(isDefaultAnnotations(null)).toBe(false);
  });
});
