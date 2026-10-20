import { describe, test, expect } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { Template, type TemplateProps } from "../../resources";
import { postSynthChecks } from "./index";
import { e2b010, isAlpineImage } from "./e2b010-debian-base-image";
import { e2b011 } from "./e2b011-template-name";
import { e2b012, stewardTools } from "./e2b012-steward-tools";

function ctx(...templates: Array<[string, TemplateProps]>): PostSynthContext {
  const entities = new Map(templates.map(([n, p]) => [n, new Template(p) as unknown as Declarable]));
  return { outputs: new Map(), entities, buildResult: { outputs: new Map(), entities, warnings: [], errors: [], sourceFileCount: 1 } };
}

const GOOD: TemplateProps = { name: "chant-steward", fromImage: "node:22-bookworm" };

describe("e2b post-synth checks", () => {
  test("the barrel lists the three checks", () => {
    expect(postSynthChecks.map((c) => c.id)).toEqual(["E2B010", "E2B011", "E2B012"]);
  });

  test("a full node image passes all three", () => {
    for (const check of postSynthChecks) expect(check.check(ctx(["steward", GOOD])), check.id).toEqual([]);
  });

  describe("E2B010: Debian-based image", () => {
    test("isAlpineImage spots Alpine by repository or tag", () => {
      for (const a of ["alpine", "alpine:3.20", "node:22-alpine", "node:22-alpine3.20", "docker.io/library/node:alpine"]) expect(isAlpineImage(a), a).toBe(true);
      for (const d of ["node:22-bookworm", "debian:12", "ubuntu:24.04", "e2bdev/base"]) expect(isAlpineImage(d), d).toBe(false);
    });

    test("fails a template on Alpine", () => {
      const [d] = e2b010.check(ctx(["steward", { ...GOOD, fromImage: "node:22-alpine" }]));
      expect(d).toMatchObject({ checkId: "E2B010", severity: "error", entity: "steward", lexicon: "e2b" });
    });
  });

  describe("E2B011: template name", () => {
    test("fails a name E2B refuses", () => {
      for (const name of ["Chant-Steward", "chant steward", "-lead", ""]) {
        const diags = e2b011.check(ctx(["steward", { ...GOOD, name }]));
        expect(diags, name).toHaveLength(1);
        expect(diags[0].severity).toBe("error");
      }
    });

    test("fails a second template with the same name", () => {
      const diags = e2b011.check(ctx(["a", GOOD], ["b", GOOD]));
      expect(diags).toHaveLength(1);
      expect(diags[0]).toMatchObject({ entity: "b" });
      expect(diags[0].message).toContain('"a" and "b"');
    });
  });

  describe("E2B012: git and Node", () => {
    test("stewardTools reads the image and the run steps", () => {
      expect(stewardTools(GOOD)).toEqual({ git: true, node: true });
      expect(stewardTools({ ...GOOD, fromImage: "node:22-bookworm-slim" })).toEqual({ git: false, node: true });
      expect(stewardTools({ name: "x", fromImage: "debian:12", run: ["apt-get install -y git nodejs"] })).toEqual({ git: true, node: true });
      expect(stewardTools({ name: "x", fromImage: "debian:12" })).toEqual({ git: false, node: false });
    });

    test("warns, naming what is missing", () => {
      const [d] = e2b012.check(ctx(["steward", { ...GOOD, fromImage: "node:22-bookworm-slim" }]));
      expect(d).toMatchObject({ checkId: "E2B012", severity: "warning" });
      expect(d.message).toContain("no sign of git");
      expect(d.message).not.toContain("Node");
    });
  });
});
