/**
 * `chant cedar generate` / `chant cedar coverage` (#1696).
 *
 * Runs the handlers against a throwaway project, with `process.cwd()` pointed
 * at it the way core's dispatcher would, and checks the output lands in the
 * project tree.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESERVED_COMMAND_NAMES } from "@intentius/chant/cli/command-group";
import { cedarCommandGroup } from "./commands";
import { cedarPlugin } from "./plugin";
import { packageDir } from "./codegen/generate";

const SCHEMA = `namespace Shop {
  entity Customer = { "email": String };
  entity Order = { "owner": Customer };
  action view appliesTo {
    principal: [Customer],
    resource: [Order],
    context: { "mfa": Bool }
  };
}
`;

function verb(name: string) {
  const command = cedarCommandGroup().commands.find((c) => c.name === name);
  if (!command) throw new Error(`no verb ${name}`);
  return command;
}

describe("the cedar command group", () => {
  it("mounts under a name core does not reserve, with generate and coverage", () => {
    const group = cedarCommandGroup();
    expect(group.name).toBe("cedar");
    expect(RESERVED_COMMAND_NAMES.has(group.name)).toBe(false);
    expect(group.commands.map((c) => c.name)).toEqual(["generate", "coverage"]);
    expect(cedarPlugin.commands?.().name).toBe("cedar");
  });

  it("rejects flags it does not know, naming the ones it does", async () => {
    await expect(verb("generate").handler({ verb: "generate", rawArgs: ["--bogus"] })).rejects.toThrow(
      /Unknown flag: --bogus[\s\S]*--out-dir/,
    );
  });
});

describe("chant cedar generate in a consumer project", () => {
  let root: string;
  const cwd = process.cwd();
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "cedar-cli-")));
    writeFileSync(join(root, "schema.cedarschema"), SCHEMA);
    writeFileSync(join(root, "chant.config.json"), JSON.stringify({ lexicons: ["cedar"] }));
    process.chdir(root);
    stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(cwd);
    stderr.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it("writes src/generated/cedar under the project and leaves the package alone", async () => {
    const pkgIndex = join(packageDir(), "src", "generated", "index.ts");
    const before = readFileSync(pkgIndex, "utf-8");

    expect(await verb("generate").handler({ verb: "generate", rawArgs: [] })).toBe(0);

    const index = join(root, "src", "generated", "cedar", "index.ts");
    expect(existsSync(index)).toBe(true);
    expect(readFileSync(index, "utf-8")).toContain('"Shop::Order"');
    expect(readFileSync(pkgIndex, "utf-8")).toBe(before);
    expect(existsSync(join(root, "node_modules"))).toBe(false);
  });

  it("takes --out-dir over the default", async () => {
    expect(await verb("generate").handler({ verb: "generate", rawArgs: ["--out-dir=authz/gen"] })).toBe(0);
    expect(existsSync(join(root, "authz", "gen", "index.ts"))).toBe(true);
    expect(existsSync(join(root, "src", "generated"))).toBe(false);
  });

  it("reports coverage against what generate wrote", async () => {
    await verb("generate").handler({ verb: "generate", rawArgs: [] });
    expect(await verb("coverage").handler({ verb: "coverage", rawArgs: ["--min-overall", "100"] })).toBe(0);
  });
});
