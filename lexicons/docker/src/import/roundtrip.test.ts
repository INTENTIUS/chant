import { describe, test, expect } from "bun:test";
import { DockerParser } from "./parser";
import { DockerGenerator } from "./generator";

describe("roundtrip: parse → generate", () => {
  test("simple service roundtrips to TypeScript", () => {
    const yaml = `services:\n  api:\n    image: nginx:1.25\n`;
    const parser = new DockerParser();
    const generator = new DockerGenerator();

    const { entities } = parser.parse(yaml);
    const { source } = generator.generate(entities);

    expect(source).toContain("new Service(");
    expect(source).toContain("nginx:1.25");
    expect(source).toContain('import { Service }');
  });

  test("generated source contains constructor calls", () => {
    const yaml = `services:\n  db:\n    image: postgres:16-alpine\n  cache:\n    image: redis:7-alpine\n`;
    const { entities } = new DockerParser().parse(yaml);
    const { source } = new DockerGenerator().generate(entities);

    // Must contain at least one constructor call
    expect(source).toMatch(/new \w+\(/);
  });
});
