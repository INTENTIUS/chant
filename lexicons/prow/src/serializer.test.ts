import { describe, expect, test } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { Container, JobConfig, Periodic, PodSpec, Postsubmit, Presubmit } from "./generated/index";
import { emitJobConfig, prowSerializer } from "./serializer";

const spec = { containers: [{ name: "test", image: "golang:1.26", command: ["go", "test"] }] };
const serialize = (entries: Array<[string, Declarable]>) => prowSerializer.serialize(new Map(entries)) as string;

describe("prow serializer", () => {
  test("is named prow, with the PROW rule prefix", () => {
    expect(prowSerializer.name).toBe("prow");
    expect(prowSerializer.rulePrefix).toBe("PROW");
  });

  test("lists presubmits and postsubmits under their repository, without chant's repo field, then periodics", () => {
    const out = serialize([
      ["a", new Periodic({ name: "nightly", cron: "0 3 * * *", spec })],
      ["b", new Postsubmit({ repo: "acme/app", name: "post", spec })],
      ["c", new Presubmit({ repo: "acme/app", name: "pre", always_run: true, spec })],
    ]);
    expect(out).toBe(
      [
        "presubmits:",
        "  acme/app:",
        "    - name: pre",
        "      always_run: true",
        "      spec:",
        "        containers:",
        "          - name: test",
        "            image: golang:1.26",
        "            command:",
        "              - go",
        "              - test",
        "postsubmits:",
        "  acme/app:",
        "    - name: post",
        "      spec:",
        "        containers:",
        "          - name: test",
        "            image: golang:1.26",
        "            command:",
        "              - go",
        "              - test",
        "periodics:",
        "  - name: nightly",
        "    cron: '0 3 * * *'",
        "    spec:",
        "      containers:",
        "        - name: test",
        "          image: golang:1.26",
        "          command:",
        "            - go",
        "            - test",
        "",
      ].join("\n"),
    );
  });

  test("keeps repositories and jobs in the order they come, and a job's fields in the order declared", () => {
    const out = serialize([
      ["x", new Presubmit({ repo: "acme/web", name: "b", decorate: true, cluster: "c1", spec })],
      ["y", new Presubmit({ repo: "acme/app", name: "a", spec })],
      ["z", new Presubmit({ repo: "acme/web", name: "a", spec })],
    ]);
    expect(out.indexOf("acme/web")).toBeLessThan(out.indexOf("acme/app"));
    expect(out.indexOf("- name: b\n      decorate: true\n      cluster: c1")).toBeGreaterThan(0);
    expect(out.indexOf("- name: b")).toBeLessThan(out.lastIndexOf("- name: a"));
  });

  test("names a job after its export when it sets no name, first", () => {
    expect(serialize([["pullUnit", new Presubmit({ repo: "acme/app", spec })]])).toContain("    - name: pullUnit\n      spec:");
  });

  test("writes property entities as the values they hold", () => {
    const out = serialize([["p", new Presubmit({ repo: "acme/app", name: "p", spec: new PodSpec({ containers: [new Container({ name: "c", image: "i" })] }) })]]);
    expect(out).toContain("      spec:\n        containers:\n          - name: c\n            image: i\n");
  });

  test("writes JobConfig's header as comment lines and a blank line above the jobs", () => {
    const out = serialize([
      ["cfg", new JobConfig({ header: "# Generated.\nEdit jobs.ts instead." })],
      ["p", new Presubmit({ repo: "acme/app", name: "p", spec })],
    ]);
    expect(out.startsWith("# Generated.\n# Edit jobs.ts instead.\n\npresubmits:\n")).toBe(true);
  });

  test("refuses a presubmit with no repo, and a second JobConfig header", () => {
    expect(() => serialize([["p", new Presubmit({ name: "p", spec } as never)]])).toThrow("names its repository with repo");
    expect(() => serialize([["a", new JobConfig({ header: "# a" })], ["b", new JobConfig({ header: "# b" })]])).toThrow("one JobConfig");
  });

  test("emitJobConfig leaves out an empty list, and writes {} for no jobs", () => {
    expect(emitJobConfig({ presubmits: {}, postsubmits: {}, periodics: [] })).toBe("{}\n");
    expect(emitJobConfig({ periodics: [{ name: "n", interval: "1h", spec }] }).startsWith("periodics:\n")).toBe(true);
  });
});
