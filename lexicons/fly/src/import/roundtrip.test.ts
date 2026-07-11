import { describe, test, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { FlyParser } from "./parser";
import { FlyGenerator } from "./generator";
import { flySerializer } from "../serializer";
import { App, Machine, MachineConfig, MachineGuest } from "../generated/index";

const here = dirname(fileURLToPath(import.meta.url));
const generatedIndex = join(here, "..", "generated", "index");

const parser = new FlyParser();
const generator = new FlyGenerator();

describe("roundtrip: flaps plan → parse → generate TypeScript", () => {
  test("an App + Machine plan generates equivalent chant TS", () => {
    const plan = JSON.stringify({
      app: { endpoint: "/v1/apps", method: "POST", body: { app_name: "my-app", org_slug: "personal" } },
      web: {
        endpoint: "/v1/apps/my-app/machines",
        method: "POST",
        body: { name: "web", region: "iad", config: { image: "nginx:1", guest: { cpu_kind: "shared", cpus: 1 } } },
      },
    });
    const ts = generator.generate(parser.parse(plan))[0].content;
    expect(ts).toContain("new App({");
    expect(ts).toContain("new Machine({");
    expect(ts).toContain("new MachineConfig({");
    expect(ts).toContain('image: "nginx:1"');
    expect(ts).toContain('region: "iad"');
  });
});

describe("roundtrip: declared entities → serialize → parse → generate → re-serialize", () => {
  test("the generated code compiles, runs, and re-serializes to equivalent flaps bodies", async () => {
    // 1. Declare an App + Machine and serialize with the #738 serializer.
    const app = new App({ name: "my-app", org_slug: "personal" });
    const web = new Machine({
      name: "web",
      region: "iad",
      config: new MachineConfig({
        image: "flyio/hellofly:latest",
        guest: new MachineGuest({ cpu_kind: "shared", cpus: 1, memory_mb: 256 }),
      }),
    });
    const entities = new Map<string, any>([
      ["app", app],
      ["web", web],
    ]);
    const planA = JSON.parse(flySerializer.serialize(entities));

    // 2. Parse the plan and generate TypeScript.
    const ir = parser.parse(JSON.stringify(planA));
    const ts = generator.generate(ir)[0].content;

    // 3. Execute the generated code: rewrite the package import to the local
    //    generated module, then dynamic-import it.
    const runnable = ts.replace(
      '"@intentius/chant-lexicon-fly"',
      JSON.stringify(generatedIndex),
    );
    const file = join(mkdtempSync(join(tmpdir(), "fly-roundtrip-")), "main.ts");
    writeFileSync(file, runnable);
    const mod = await import(file);

    // 4. Re-serialize the regenerated entities.
    const regenerated = new Map<string, any>(Object.entries(mod));
    const planB = JSON.parse(flySerializer.serialize(regenerated));

    // The bodies survive the round-trip. Entity keys differ (variable names are
    // camelCased from the resource name), so compare the create bodies by kind.
    const bodies = (plan: Record<string, any>) => Object.values(plan).map((r) => r.body).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(bodies(planB)).toEqual(bodies(planA));
  });
});
