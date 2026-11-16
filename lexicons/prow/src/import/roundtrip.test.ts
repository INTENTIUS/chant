/**
 * `chant import` then `chant build` gives back the job config imported: the
 * same data for any job config, and the same bytes, comments and all, for
 * one written in the YAML style chant writes.
 */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { fixture, roundTrip } from "../testdata/build";

const SMALL = `presubmits:
  acme/app:
    - name: pull-app-unit
      always_run: true
      decorate: true
      skip_if_only_changed: ^docs/
      branches:
        - ^main$
      spec:
        containers:
          - name: test
            image: golang:1.26
            command:
              - go
              - test
              - ./...
postsubmits:
  acme/app:
    - name: post-app-unit
      run_if_changed: ^src/
      max_concurrency: 1
      spec:
        containers:
          - name: test
            image: golang:1.26
periodics:
  - name: periodic-app-e2e
    interval: '24h'
    extra_refs:
      - org: acme
        repo: app
        base_ref: main
    spec:
      containers:
        - name: e2e
          image: golang:1.26
`;

describe("import, then build", () => {
  test("a job config of each kind comes back as it was", async () => {
    const { output, errors, source } = await roundTrip(SMALL);
    expect(errors).toEqual([]);
    expect(source).toContain("new Presubmit(");
    expect(source).toContain("new Postsubmit(");
    expect(source).toContain("new Periodic(");
    expect(output).toBe(SMALL);
  });

  test("two repositories keep their order, and a script keeps its newlines", async () => {
    const text = `presubmits:
  acme/web:
    - name: lint
      spec:
        containers:
          - name: lint
            image: node:24
            args:
              - |-
                set -eu
                echo "\${PULL_NUMBER}" \`date\` \\n
  acme/app:
    - name: lint
      spec:
        containers:
          - name: lint
            image: node:24
`;
    const { output, errors } = await roundTrip(text);
    expect(errors).toEqual([]);
    expect(output).toBe(text);
  });

  test("a job config written by hand comes back as the same data, and in chant's style", async () => {
    const text = SMALL.replace("interval: '24h'", "interval: 24h").replace("      branches:\n        - ^main$\n", "      branches: [^main$]\n");
    const first = await roundTrip(text);
    expect(first.errors).toEqual([]);
    expect(parseYAML(first.output)).toEqual(parseYAML(text));
    expect(first.output).toBe(SMALL);
    // Importing what chant built builds it again unchanged.
    expect((await roundTrip(first.output)).output).toBe(first.output);
  });

  for (const name of ["default", "full", "config-repo"]) {
    test(`terragucci's ${name} job config, with its header`, async () => {
      const text = fixture(`terragucci/${name}.yaml`);
      const { output, errors } = await roundTrip(text);
      expect(errors).toEqual([]);
      expect(output).toBe(text);
    });
  }
});
