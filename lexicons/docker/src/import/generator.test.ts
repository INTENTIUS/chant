import { describe, test, expect } from "vitest";
import { DockerGenerator } from "./generator";
import type { ServiceIR, VolumeIR, NetworkIR, ConfigIR, SecretIR, DockerfileIR } from "./parser";

describe("DockerGenerator", () => {
  test("generates Service from IR with image", () => {
    const entities: ServiceIR[] = [
      { kind: "service", name: "api", props: { image: "nginx:1.25" } },
    ];
    const { source } = new DockerGenerator().generate(entities);
    expect(source).toContain("import { Service }");
    expect(source).toContain("new Service(");
    expect(source).toContain("nginx:1.25");
  });

  test("generates Service with ports and environment", () => {
    const entities: ServiceIR[] = [
      {
        kind: "service",
        name: "api",
        props: {
          image: "node:20",
          ports: ["3000:3000"],
          environment: { NODE_ENV: "production" },
        },
      },
    ];
    const { source } = new DockerGenerator().generate(entities);
    expect(source).toContain("3000:3000");
    expect(source).toContain("NODE_ENV");
    expect(source).toContain("production");
  });

  test("generates Config entity", () => {
    const entities: ConfigIR[] = [
      { kind: "config", name: "app-config", props: { file: "./config/app.conf" } },
    ];
    const { source } = new DockerGenerator().generate(entities);
    expect(source).toContain("import { Config }");
    expect(source).toContain("new Config(");
    expect(source).toContain("app.conf");
  });

  test("generates Secret entity", () => {
    const entities: SecretIR[] = [
      { kind: "secret", name: "db-password", props: { file: "./secrets/db.txt" } },
    ];
    const { source } = new DockerGenerator().generate(entities);
    expect(source).toContain("import { Secret }");
    expect(source).toContain("new Secret(");
  });

  test("single-stage Dockerfile generates flat props (existing behaviour)", () => {
    const entities: DockerfileIR[] = [
      {
        kind: "dockerfile",
        name: "builder",
        stages: [
          {
            from: "node:20-alpine",
            instructions: [
              { instruction: "RUN", value: "npm ci" },
              { instruction: "CMD", value: '["node", "index.js"]' },
            ],
          },
        ],
      },
    ];
    const { source } = new DockerGenerator().generate(entities);
    expect(source).toContain("import { Dockerfile }");
    expect(source).toContain("new Dockerfile(");
    expect(source).toContain("node:20-alpine");
    expect(source).not.toContain('"stages"');
  });

  test("multi-stage Dockerfile generates stages: array form", () => {
    const entities: DockerfileIR[] = [
      {
        kind: "dockerfile",
        name: "app",
        stages: [
          { from: "node:20-alpine", as: "builder", instructions: [{ instruction: "RUN", value: "npm ci" }] },
          { from: "nginx:1.25", as: "runner", instructions: [] },
        ],
      },
    ];
    const { source } = new DockerGenerator().generate(entities);
    expect(source).toContain("stages");
    expect(source).toContain("node:20-alpine");
    expect(source).toContain("nginx:1.25");
  });

  test("import line includes only needed types", () => {
    const entities: VolumeIR[] = [
      { kind: "volume", name: "data", props: {} },
    ];
    const { source } = new DockerGenerator().generate(entities);
    expect(source).toContain("import { Volume }");
    expect(source).not.toContain("Service");
    expect(source).not.toContain("Network");
  });

  test("generates correct imports for multiple entity types", () => {
    const entities = [
      { kind: "service" as const, name: "api", props: { image: "nginx:1.25" } },
      {
        kind: "dockerfile" as const,
        name: "build",
        stages: [{ from: "node:20", instructions: [] }],
      },
    ];
    const { source } = new DockerGenerator().generate(entities);
    expect(source).toContain("Dockerfile");
    expect(source).toContain("Service");
  });

  test("sanitizes kebab-case names to camelCase", () => {
    const entities: ServiceIR[] = [
      { kind: "service", name: "my-web-server", props: { image: "nginx:1.25" } },
    ];
    const { source } = new DockerGenerator().generate(entities);
    expect(source).toContain("myWebServer");
  });

  test("generates Network entity", () => {
    const entities: NetworkIR[] = [
      { kind: "network", name: "backend", props: { driver: "bridge" } },
    ];
    const { source } = new DockerGenerator().generate(entities);
    expect(source).toContain("import { Network }");
    expect(source).toContain("new Network(");
  });
});
