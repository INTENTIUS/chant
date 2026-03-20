import { describe, test, expect } from "bun:test";
import { DockerGenerator } from "./generator";
import type { ServiceIR, DockerfileIR } from "./parser";

describe("DockerGenerator", () => {
  test("generates Service from IR", () => {
    const generator = new DockerGenerator();
    const entities: ServiceIR[] = [
      { kind: "service", name: "api", props: { image: "nginx:1.25" } },
    ];
    const { source } = generator.generate(entities);

    expect(source).toContain("import { Service }");
    expect(source).toContain("new Service(");
    expect(source).toContain("nginx:1.25");
  });

  test("generates Dockerfile from IR", () => {
    const generator = new DockerGenerator();
    const entities: DockerfileIR[] = [
      {
        kind: "dockerfile",
        name: "builder",
        from: "node:20-alpine",
        instructions: [
          { instruction: "RUN", value: "npm ci" },
          { instruction: "CMD", value: '["node", "index.js"]' },
        ],
      },
    ];
    const { source } = generator.generate(entities);

    expect(source).toContain("import { Dockerfile }");
    expect(source).toContain("new Dockerfile(");
    expect(source).toContain("node:20-alpine");
  });

  test("sanitizes kebab-case names to camelCase", () => {
    const generator = new DockerGenerator();
    const entities: ServiceIR[] = [
      { kind: "service", name: "my-web-server", props: { image: "nginx:1.25" } },
    ];
    const { source } = generator.generate(entities);
    expect(source).toContain("myWebServer");
  });

  test("generates correct imports for multiple entity types", () => {
    const generator = new DockerGenerator();
    const entities = [
      { kind: "service" as const, name: "api", props: { image: "nginx:1.25" } },
      {
        kind: "dockerfile" as const,
        name: "build",
        from: "node:20",
        instructions: [],
      },
    ];
    const { source } = generator.generate(entities);
    expect(source).toContain("Dockerfile");
    expect(source).toContain("Service");
  });
});
