import { describe, test, expect } from "vitest";
import { FlywayParser } from "./parser";
import { FlywayGenerator } from "./generator";

const parser = new FlywayParser();
const generator = new FlywayGenerator();

describe("roundtrip: parse → generate", () => {
  test("simple project roundtrip", () => {
    const toml = `
id = "my-project"
name = "my-project"
databaseType = "postgresql"
`;
    const ir = parser.parse(toml);
    const files = generator.generate(ir);

    expect(files).toHaveLength(1);
    const content = files[0].content;
    expect(content).toContain("import");
    expect(content).toContain("export const");
    expect(content).toContain("my-project");
  });

  test("project with flyway config roundtrip", () => {
    const toml = `
id = "my-project"
name = "my-project"

[flyway]
locations = ["filesystem:sql/migrations"]
defaultSchema = "public"
cleanDisabled = true
`;
    const ir = parser.parse(toml);
    expect(ir.resources.length).toBeGreaterThanOrEqual(2);

    const files = generator.generate(ir);
    const content = files[0].content;
    expect(content).toContain("import");
    expect(content).toContain("export const");
    expect(content).toContain("sql/migrations");
  });

  test("project with environments roundtrip", () => {
    const toml = `
id = "my-project"
name = "my-project"

[environments.dev]
url = "jdbc:postgresql://localhost:5432/devdb"
user = "dev_user"
schemas = ["public"]

[environments.prod]
url = "jdbc:postgresql://prod.example.com:5432/proddb"
user = "prod_user"
schemas = ["public", "app"]
`;
    const ir = parser.parse(toml);
    expect(ir.resources.length).toBeGreaterThanOrEqual(3);

    const files = generator.generate(ir);
    const content = files[0].content;
    expect(content).toContain("dev");
    expect(content).toContain("prod");
    expect(content).toContain("export const");
  });

  test("full config roundtrip", () => {
    const toml = `
id = "full-project"
name = "Full Project"
databaseType = "postgresql"

[flyway]
locations = ["filesystem:sql/migrations", "filesystem:sql/seed"]
defaultSchema = "public"
cleanDisabled = true
mixed = false
outOfOrder = false
validateOnMigrate = true

[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"
user = "dev_user"
schemas = ["public"]

[environments.staging]
url = "jdbc:postgresql://staging.internal:5432/stage"
user = "stage_user"
schemas = ["public"]

[environments.prod]
url = "jdbc:postgresql://prod.internal:5432/prod"
user = "prod_user"
schemas = ["public"]

[flywayDesktop]
developmentEnvironment = "dev"
shadowEnvironment = "shadow"
`;
    const ir = parser.parse(toml);
    expect(ir.resources.length).toBeGreaterThanOrEqual(4);

    const files = generator.generate(ir);
    expect(files.length).toBeGreaterThan(0);
    const content = files[0].content;
    expect(content).toContain("import");
    expect(content).toContain("export const");
  });

  test("resolvers roundtrip", () => {
    const toml = `
[flyway]
locations = ["filesystem:sql"]

[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"
resolvers = ["placeholder"]
`;
    const ir = parser.parse(toml);
    const files = generator.generate(ir);
    expect(files.length).toBeGreaterThan(0);
    const content = files[0].content;
    expect(content).toContain("export const");
  });
});
