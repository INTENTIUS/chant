import { describe, expect, it } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import type { SerializerResult } from "@intentius/chant/serializer";
import { e2bSerializer } from "./serializer";
import { Template } from "./resources";

function serialize(entries: Array<[string, unknown]>): SerializerResult {
  return e2bSerializer.serialize(new Map(entries as Array<[string, Declarable]>)) as SerializerResult;
}

describe("e2b serializer", () => {
  it("writes a Dockerfile and an e2b.toml per template, named after it", () => {
    const out = serialize([
      [
        "steward",
        new Template({
          name: "chant-steward",
          fromImage: "node:22-bookworm",
          env: { CI: "1", GREETING: 'say "hi"' },
          workdir: "/home/user",
          run: ["apt-get update", "apt-get install -y jq"],
          startCmd: "node server.js",
          readyCmd: "curl -sf localhost:3000",
          cpuCount: 2,
          memoryMB: 2048,
          teamId: "team-123",
        }),
      ],
    ]);

    expect(Object.keys(out.files ?? {}).sort()).toEqual(["e2b.chant-steward.Dockerfile", "e2b.chant-steward.toml"]);
    expect(out.verbatimFiles?.sort()).toEqual(["e2b.chant-steward.Dockerfile", "e2b.chant-steward.toml"]);
    expect(out.files?.["e2b.chant-steward.Dockerfile"]).toBe(
      [
        "FROM node:22-bookworm",
        'ENV CI="1"',
        'ENV GREETING="say \\"hi\\""',
        "WORKDIR /home/user",
        "RUN apt-get update",
        "RUN apt-get install -y jq",
        "",
      ].join("\n"),
    );
    expect(out.files?.["e2b.chant-steward.toml"]).toBe(
      [
        "# Built with: e2b template build --config e2b.chant-steward.toml",
        'template_name = "chant-steward"',
        'dockerfile = "e2b.chant-steward.Dockerfile"',
        'start_cmd = "node server.js"',
        'ready_cmd = "curl -sf localhost:3000"',
        "cpu_count = 2",
        "memory_mb = 2048",
        'team_id = "team-123"',
        "",
      ].join("\n"),
    );
    expect(JSON.parse(out.primary)).toEqual({
      templates: {
        steward: {
          name: "chant-steward",
          dockerfile: "e2b.chant-steward.Dockerfile",
          config: "e2b.chant-steward.toml",
          cpuCount: 2,
          memoryMB: 2048,
        },
      },
    });
  });

  it("leaves out what a template does not set", () => {
    const out = serialize([["base", new Template({ name: "slim", fromImage: "debian:12" })]]);
    expect(out.files?.["e2b.slim.Dockerfile"]).toBe("FROM debian:12\n");
    expect(out.files?.["e2b.slim.toml"]).not.toMatch(/start_cmd|ready_cmd|cpu_count|memory_mb|team_id/);
    expect(JSON.parse(out.primary).templates.base).toEqual({ name: "slim", dockerfile: "e2b.slim.Dockerfile", config: "e2b.slim.toml" });
  });

  it("orders templates by export name and ignores anything that is not one", () => {
    const out = serialize([
      ["zeta", new Template({ name: "zeta", fromImage: "node:22-bookworm" })],
      ["alpha", new Template({ name: "alpha", fromImage: "node:22-bookworm" })],
      ["other", { entityType: "Other::Thing", props: {} }],
    ]);
    expect(Object.keys(JSON.parse(out.primary).templates)).toEqual(["alpha", "zeta"]);
    expect(Object.keys(out.files ?? {})).toHaveLength(4);
  });

  it("gives a build with no templates an empty index", () => {
    const out = serialize([]);
    expect(JSON.parse(out.primary)).toEqual({ templates: {} });
    expect(out.files).toEqual({});
  });
});
