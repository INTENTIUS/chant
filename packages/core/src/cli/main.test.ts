import { describe, test, expect } from "bun:test";
import { parseArgs } from "./main";
import { resolveCommand, type CommandDef, type ParsedArgs } from "./registry";

describe("parseArgs", () => {
  test("parses command as first positional arg", () => {
    const result = parseArgs(["build"]);
    expect(result.command).toBe("build");
    expect(result.path).toBe(".");
    expect(result.help).toBe(false);
  });

  test("parses path as second positional arg (defaults to '.')", () => {
    const result = parseArgs(["build", "./infra"]);
    expect(result.command).toBe("build");
    expect(result.path).toBe("./infra");
  });

  test("defaults path to '.' when not provided", () => {
    const result = parseArgs(["build"]);
    expect(result.path).toBe(".");
  });

  test("parses --help flag", () => {
    const result = parseArgs(["--help"]);
    expect(result.help).toBe(true);
  });

  test("parses -h flag", () => {
    const result = parseArgs(["-h"]);
    expect(result.help).toBe(true);
  });

  test("parses --output with value", () => {
    const result = parseArgs(["build", "--output", "stack.json"]);
    expect(result.output).toBe("stack.json");
    expect(result.command).toBe("build");
  });

  test("parses -o with value", () => {
    const result = parseArgs(["build", "-o", "stack.json"]);
    expect(result.output).toBe("stack.json");
  });

  test("parses --format with json value", () => {
    const result = parseArgs(["build", "--format", "json"]);
    expect(result.format).toBe("json");
  });

  test("parses --format with yaml value", () => {
    const result = parseArgs(["build", "--format", "yaml"]);
    expect(result.format).toBe("yaml");
  });

  test("parses -f with json value", () => {
    const result = parseArgs(["build", "-f", "json"]);
    expect(result.format).toBe("json");
  });

  test("parses -f with yaml value", () => {
    const result = parseArgs(["build", "-f", "yaml"]);
    expect(result.format).toBe("yaml");
  });

  test("accepts any format value (validation done per-command)", () => {
    const result = parseArgs(["build", "--format", "xml"]);
    expect(result.format).toBe("xml"); // format is passed as-is to main
  });

  test("accepts invalid format values (validation done per-command)", () => {
    const result = parseArgs(["build", "-f", "invalid"]);
    expect(result.format).toBe("invalid"); // format is passed as-is to main
  });

  test("combines multiple options", () => {
    const result = parseArgs([
      "build",
      "./infra",
      "--output",
      "stack.json",
      "--format",
      "yaml",
      "--help",
    ]);
    expect(result.command).toBe("build");
    expect(result.path).toBe("./infra");
    expect(result.output).toBe("stack.json");
    expect(result.format).toBe("yaml");
    expect(result.help).toBe(true);
  });

  test("handles options in different order", () => {
    const result = parseArgs([
      "--output",
      "stack.json",
      "build",
      "--format",
      "yaml",
      "./infra",
    ]);
    expect(result.command).toBe("build");
    expect(result.path).toBe("./infra");
    expect(result.output).toBe("stack.json");
    expect(result.format).toBe("yaml");
  });

  test("handles empty args array", () => {
    const result = parseArgs([]);
    expect(result.command).toBe("");
    expect(result.path).toBe(".");
    expect(result.output).toBe(undefined);
    expect(result.format).toBe(""); // no format specified, defaults applied per-command in main()
    expect(result.help).toBe(false);
  });

  test("ignores unknown flags", () => {
    const result = parseArgs(["build", "--unknown", "value"]);
    expect(result.command).toBe("build");
    // Unknown flags are silently ignored
  });

  test("parses --watch flag", () => {
    const result = parseArgs(["build", "--watch"]);
    expect(result.watch).toBe(true);
    expect(result.command).toBe("build");
  });

  test("parses -w flag", () => {
    const result = parseArgs(["build", "-w"]);
    expect(result.watch).toBe(true);
  });

  test("watch defaults to false", () => {
    const result = parseArgs(["build"]);
    expect(result.watch).toBe(false);
  });

  test("combines --watch with other options", () => {
    const result = parseArgs(["build", "./infra", "--watch", "--format", "yaml"]);
    expect(result.watch).toBe(true);
    expect(result.command).toBe("build");
    expect(result.path).toBe("./infra");
    expect(result.format).toBe("yaml");
  });

  test("parses --watch with lint command", () => {
    const result = parseArgs(["lint", "./infra/", "-w"]);
    expect(result.watch).toBe(true);
    expect(result.command).toBe("lint");
    expect(result.path).toBe("./infra/");
  });

  test("parses extraPositional as third positional arg", () => {
    const result = parseArgs(["init", "lexicon", "k8s"]);
    expect(result.command).toBe("init");
    expect(result.path).toBe("lexicon");
    expect(result.extraPositional).toBe("k8s");
  });

  test("parses extraPositional2 as fourth positional arg", () => {
    const result = parseArgs(["init", "lexicon", "k8s", "./my-path"]);
    expect(result.command).toBe("init");
    expect(result.path).toBe("lexicon");
    expect(result.extraPositional).toBe("k8s");
    expect(result.extraPositional2).toBe("./my-path");
  });

  test("extraPositional2 is undefined when only 3 positional args", () => {
    const result = parseArgs(["dev", "generate", "."]);
    expect(result.command).toBe("dev");
    expect(result.path).toBe("generate");
    expect(result.extraPositional).toBe(".");
    expect(result.extraPositional2).toBe(undefined);
  });
});

// ── resolveCommand tests ──────────────────────────────────────────

describe("resolveCommand", () => {
  const noop = async () => 0;

  const testRegistry: CommandDef[] = [
    { name: "build", handler: noop },
    { name: "dev generate", requiresPlugins: true, handler: noop },
    { name: "dev publish", requiresPlugins: true, handler: noop },
    { name: "serve lsp", handler: noop },
    { name: "init", handler: noop },
    { name: "init lexicon", handler: noop },
    { name: "dev", handler: noop },
  ];

  function makeArgs(overrides: Partial<ParsedArgs>): ParsedArgs {
    return {
      command: "",
      path: ".",
      format: "",
      fix: false,
      watch: false,
      verbose: false,
      help: false,
      ...overrides,
    };
  }

  test("resolves simple command", () => {
    const result = resolveCommand(makeArgs({ command: "build" }), testRegistry);
    expect(result).not.toBeNull();
    expect(result!.def.name).toBe("build");
    expect(result!.compound).toBe(false);
  });

  test("resolves compound command (dev generate)", () => {
    const result = resolveCommand(makeArgs({ command: "dev", path: "generate" }), testRegistry);
    expect(result).not.toBeNull();
    expect(result!.def.name).toBe("dev generate");
    expect(result!.compound).toBe(true);
  });

  test("resolves compound command (serve lsp)", () => {
    const result = resolveCommand(makeArgs({ command: "serve", path: "lsp" }), testRegistry);
    expect(result).not.toBeNull();
    expect(result!.def.name).toBe("serve lsp");
    expect(result!.compound).toBe(true);
  });

  test("resolves compound command (init lexicon)", () => {
    const result = resolveCommand(makeArgs({ command: "init", path: "lexicon" }), testRegistry);
    expect(result).not.toBeNull();
    expect(result!.def.name).toBe("init lexicon");
    expect(result!.compound).toBe(true);
  });

  test("falls back to simple when compound doesn't match", () => {
    const result = resolveCommand(makeArgs({ command: "dev", path: "unknown" }), testRegistry);
    expect(result).not.toBeNull();
    expect(result!.def.name).toBe("dev");
    expect(result!.compound).toBe(false);
  });

  test("resolves init without lexicon subcommand", () => {
    const result = resolveCommand(makeArgs({ command: "init", path: "." }), testRegistry);
    expect(result).not.toBeNull();
    expect(result!.def.name).toBe("init");
    expect(result!.compound).toBe(false);
  });

  test("returns null for unknown command", () => {
    const result = resolveCommand(makeArgs({ command: "foobar" }), testRegistry);
    expect(result).toBeNull();
  });

  test("compound takes priority over simple match", () => {
    const result = resolveCommand(makeArgs({ command: "dev", path: "generate" }), testRegistry);
    expect(result!.def.name).toBe("dev generate");
    expect(result!.compound).toBe(true);
  });
});
