import { describe, test, expect } from "vitest";
import { EventEmitter } from "node:events";
import { parseArgs, waitForStreamDrain } from "./main";
import { resolveCommand, type CommandDef, type ParsedArgs } from "./registry";

describe("parseArgs", () => {
  test("--fold and --no-fold set the tri-state fold option (#1134)", () => {
    expect(parseArgs(["build", "src"]).fold).toBeUndefined();
    expect(parseArgs(["build", "src", "--fold"]).fold).toBe(true);
    expect(parseArgs(["build", "src", "--no-fold"]).fold).toBe(false);
  });

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

  test("parses graph --detail as a number", () => {
    const result = parseArgs(["graph", "--format", "ir", "--detail", "1"]);
    expect(result.detail).toBe(1);
  });

  test("parses graph --lens with a kind:target value", () => {
    const result = parseArgs(["graph", "--format", "ir", "--lens", "blast:vpc"]);
    expect(result.lens).toBe("blast:vpc");
  });

  test("parses graph --up and --down flags", () => {
    const result = parseArgs(["graph", "--lens", "blast:vpc", "--up", "--down"]);
    expect(result.up).toBe(true);
    expect(result.down).toBe(true);
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

  test("throws on an unknown bare flag instead of silently ignoring it (chant #1127)", () => {
    // Was "ignores unknown flags" — pinned the old silent-drop as intended
    // behavior. #1127 flips it: an unrecognized `--flag` is a hard error.
    expect(() => parseArgs(["build", "--unknown", "value"])).toThrow(/Unknown flag: --unknown/);
  });

  test("unknown flag error points at --help", () => {
    expect(() => parseArgs(["build", "--unknown"])).toThrow(/--help/);
  });

  test("throws on an unknown joined flag (--unknown=value)", () => {
    expect(() => parseArgs(["build", "--unknown=value"])).toThrow(/Unknown flag: --unknown/);
  });

  test("unknown short flags are still silently ignored (unchanged; out of #1127 scope)", () => {
    const result = parseArgs(["build", "-x", "value"]);
    expect(result.command).toBe("build");
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

  // ── components release/status flags (#568) ──────────────────────────────

  test("parses --component, --digest, --git-sha, --run-id, --actor for components release", () => {
    const result = parseArgs([
      "components", "release", "prod",
      "--component", "search-service",
      "--digest", "sha256:abc123",
      "--git-sha", "deadbeef",
      "--run-id", "run-1",
      "--actor", "alice",
    ]);
    expect(result.command).toBe("components");
    expect(result.path).toBe("release");
    expect(result.extraPositional).toBe("prod");
    expect(result.component).toBe("search-service");
    expect(result.digest).toBe("sha256:abc123");
    expect(result.gitSha).toBe("deadbeef");
    expect(result.runId).toBe("run-1");
    expect(result.actor).toBe("alice");
  });

  test("parses --compare-to and --live for components status", () => {
    const result = parseArgs(["components", "status", "prod", "--compare-to", "staging", "--live", "--json"]);
    expect(result.command).toBe("components");
    expect(result.path).toBe("status");
    expect(result.extraPositional).toBe("prod");
    expect(result.compareTo).toBe("staging");
    expect(result.live).toBe(true);
    expect(result.json).toBe(true);
  });

  // ── --no-release-record (#597) ───────────────────────────────────────────

  test("parses --no-release-record for run --components", () => {
    const result = parseArgs(["run", "--components", "search-service", "--env", "staging", "--no-release-record"]);
    expect(result.components).toBe(true);
    expect(result.env).toBe("staging");
    expect(result.noReleaseRecord).toBe(true);
  });

  test("--no-release-record is undefined (not false) when omitted", () => {
    const result = parseArgs(["run", "--components", "search-service"]);
    expect(result.noReleaseRecord).toBeUndefined();
  });

  // ── --progress-json (M3, behold roadmap) ─────────────────────────────────

  test("parses --progress-json for run --components", () => {
    const result = parseArgs(["run", "--components", "search-service", "--env", "staging", "--progress-json"]);
    expect(result.components).toBe(true);
    expect(result.env).toBe("staging");
    expect(result.progressJson).toBe(true);
  });

  test("--progress-json is undefined (not false) when omitted", () => {
    const result = parseArgs(["run", "--components", "search-service"]);
    expect(result.progressJson).toBeUndefined();
  });

  // ── --param / --params-file (chant #1064) ────────────────────────────────

  test("parses a single --param as a one-element array", () => {
    const result = parseArgs(["build", "src", "--param", "tier=production"]);
    expect(result.param).toEqual(["tier=production"]);
  });

  test("repeated --param accumulates in order", () => {
    const result = parseArgs(["build", "src", "--param", "tier=production", "--param", "env=staging"]);
    expect(result.param).toEqual(["tier=production", "env=staging"]);
  });

  test("--param is undefined when omitted", () => {
    const result = parseArgs(["build", "src"]);
    expect(result.param).toBeUndefined();
  });

  test("parses --params-file with a path", () => {
    const result = parseArgs(["build", "src", "--params-file", "./params.json"]);
    expect(result.paramsFile).toBe("./params.json");
  });

  test("plain --param name=value is unaffected", () => {
    const result = parseArgs(["build", "src", "--param", "tier=production"]);
    expect(result.param).toEqual(["tier=production"]);
  });

  // ── generic --flag=value joined form (chant #1127) ────────────────────────
  // #1118 taught this parser to hard-error `--param=name=value` specifically,
  // because it was the one flag known (from #1118's investigation) to sit
  // behind a silent drop. #1127's audit found the drop was general — every
  // value-taking flag shares it — so the fix is general too: split any
  // `--flag=value` token at its first `=` and re-dispatch as `--flag` +
  // `value`, the exact shape every branch below already handles. This
  // supersedes #1118's `--param=` hard error entirely: the joined form is now
  // just as valid as the space-separated one, for every flag, not a rejected
  // special case for one flag.

  test("--param=name=value now works instead of throwing — joined form matches the space-separated form", () => {
    const result = parseArgs(["build", "src", "--param=tier=production"]);
    expect(result.param).toEqual(["tier=production"]);
  });

  test("--env=value joined form works", () => {
    const result = parseArgs(["build", "src", "--env=staging"]);
    expect(result.env).toBe("staging");
  });

  test("--format=value joined form works", () => {
    const result = parseArgs(["build", "src", "--format=yaml"]);
    expect(result.format).toBe("yaml");
  });

  test("--lexicon=value joined form works", () => {
    const result = parseArgs(["build", "src", "--lexicon=aws"]);
    expect(result.lexicon).toBe("aws");
  });

  test("repeated --param=name=value (joined) accumulates in order, same as space-separated", () => {
    const result = parseArgs(["build", "src", "--param=tier=production", "--param=env=staging"]);
    expect(result.param).toEqual(["tier=production", "env=staging"]);
  });

  test("joined form only splits on the FIRST '=' — a value containing '=' is preserved whole", () => {
    // --param's own value shape is `name=value`, so `--param=tier=production`
    // must split into flag `--param` + value `tier=production`, not further
    // fragment on the second `=`.
    const result = parseArgs(["build", "src", "--param=tier=production=east"]);
    expect(result.param).toEqual(["tier=production=east"]);
  });

  test("joined form works mixed with space-separated flags in the same invocation", () => {
    const result = parseArgs(["build", "src", "--env=prod", "--format", "json", "--lexicon=k8s"]);
    expect(result.env).toBe("prod");
    expect(result.format).toBe("json");
    expect(result.lexicon).toBe("k8s");
  });

  // ── boolean-only flag given a joined value (chant #1127) ──────────────────
  // Decision: reject it. A boolean flag (--fold, --watch, --json, ...) has no
  // value slot — its branch just sets a field to `true` and never consumes a
  // following token. Silently coercing "true"/"false" would need to invent
  // parsing rules (what about "1", "yes", mixed case?) for a form none of
  // this CLI's flags need; silently dropping the value and reinterpreting it
  // as the next positional (a path, a component name, ...) is exactly the
  // silent misparse #1127 closes. So it errors, naming the flag as boolean.

  test("a boolean flag given a joined value throws, naming the flag as boolean", () => {
    expect(() => parseArgs(["build", "src", "--fold=true"])).toThrow(/--fold is a boolean flag/);
  });

  test("boolean-with-value error does not silently reinterpret the value as a positional", () => {
    expect(() => parseArgs(["build", "src", "--watch=false"])).toThrow(/--watch is a boolean flag/);
  });

  test("--json=1 (another boolean flag) also throws", () => {
    expect(() => parseArgs(["run", "myop", "--json=1"])).toThrow(/--json is a boolean flag/);
  });

  test("--report keeps its context-sensitive bare-vs-value behavior when joined", () => {
    // --report is deliberately not in the boolean-reject set: bare --report is
    // a boolean (`run`), but --report <path> is a SARIF destination (migrate).
    // The joined form should resolve the same way the space-separated one does.
    const result = parseArgs(["migrate", "wf.yml", "--report=out.sarif"]);
    expect(result.reportFile).toBe("out.sarif");
    expect(result.report).toBeUndefined();
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
    { name: "lifecycle plan", handler: noop },
    { name: "lifecycle", handler: noop },
    { name: "components status", handler: noop },
    { name: "components release", handler: noop },
    { name: "components", handler: noop },
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
      live: false,
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

  test("`lc` is an alias for `lifecycle` (compound)", () => {
    const result = resolveCommand(makeArgs({ command: "lc", path: "plan" }), testRegistry);
    expect(result!.def.name).toBe("lifecycle plan");
    expect(result!.compound).toBe(true);
  });

  test("`lc` is an alias for `lifecycle` (simple)", () => {
    const result = resolveCommand(makeArgs({ command: "lc" }), testRegistry);
    expect(result!.def.name).toBe("lifecycle");
    expect(result!.compound).toBe(false);
  });

  test("resolves components status as compound command", () => {
    const result = resolveCommand(makeArgs({ command: "components", path: "status" }), testRegistry);
    expect(result!.def.name).toBe("components status");
    expect(result!.compound).toBe(true);
  });

  test("resolves components release as compound command", () => {
    const result = resolveCommand(makeArgs({ command: "components", path: "release" }), testRegistry);
    expect(result!.def.name).toBe("components release");
    expect(result!.compound).toBe(true);
  });

  test("falls back to unknown components subcommand handler", () => {
    const result = resolveCommand(makeArgs({ command: "components", path: "bogus" }), testRegistry);
    expect(result!.def.name).toBe("components");
    expect(result!.compound).toBe(false);
  });

  test("resolves run status as compound command", () => {
    const registry: CommandDef[] = [
      { name: "run list", handler: noop },
      { name: "run status", handler: noop },
      { name: "run signal", handler: noop },
      { name: "run cancel", handler: noop },
      { name: "run log", handler: noop },
      { name: "run", handler: noop },
    ];
    const result = resolveCommand(makeArgs({ command: "run", path: "status" }), registry);
    expect(result!.def.name).toBe("run status");
    expect(result!.compound).toBe(true);
  });

  test("resolves run <name> as simple command", () => {
    const registry: CommandDef[] = [
      { name: "run list", handler: noop },
      { name: "run status", handler: noop },
      { name: "run", handler: noop },
    ];
    const result = resolveCommand(makeArgs({ command: "run", path: "alb-deploy" }), registry);
    expect(result!.def.name).toBe("run");
    expect(result!.compound).toBe(false);
  });
});

describe("parseArgs — run flags", () => {
  test("parses --profile flag", () => {
    const result = parseArgs(["run", "alb-deploy", "--profile", "local"]);
    expect(result.command).toBe("run");
    expect(result.path).toBe("alb-deploy");
    expect(result.profile).toBe("local");
  });

  test("parses -p shorthand for --profile", () => {
    const result = parseArgs(["run", "alb-deploy", "-p", "cloud"]);
    expect(result.profile).toBe("cloud");
  });

  test("parses --report flag", () => {
    const result = parseArgs(["run", "alb-deploy", "--report"]);
    expect(result.command).toBe("run");
    expect(result.path).toBe("alb-deploy");
    expect(result.report).toBe(true);
  });

  test("report is undefined when not provided", () => {
    const result = parseArgs(["run", "alb-deploy"]);
    expect(result.report).toBe(undefined);
  });

  test("profile is undefined when not provided", () => {
    const result = parseArgs(["run", "alb-deploy"]);
    expect(result.profile).toBe(undefined);
  });

  test("run signal parses op name and signal into positionals", () => {
    const result = parseArgs(["run", "signal", "alb-deploy", "gate-dns"]);
    expect(result.command).toBe("run");
    expect(result.path).toBe("signal");
    expect(result.extraPositional).toBe("alb-deploy");
    expect(result.extraPositional2).toBe("gate-dns");
  });
});

describe("waitForStreamDrain", () => {
  // Minimal writable stub — just the surface waitForStreamDrain reads.
  function fakeStream(len: number): NodeJS.WriteStream & { writableLength: number } {
    const s = new EventEmitter() as unknown as NodeJS.WriteStream & { writableLength: number };
    s.writableLength = len;
    (s as { writableEnded: boolean }).writableEnded = false;
    (s as { destroyed: boolean }).destroyed = false;
    return s;
  }

  test("resolves immediately when nothing is buffered (e.g. a TTY)", async () => {
    await expect(waitForStreamDrain(fakeStream(0))).resolves.toBeUndefined();
  });

  test("waits through drains until the buffer is actually empty", async () => {
    const s = fakeStream(1000);
    let done = false;
    const p = waitForStreamDrain(s).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    // A drain while still buffered must NOT resolve (large one-shot write, kernel
    // took a slice, more remains) — it re-arms.
    s.emit("drain");
    await Promise.resolve();
    expect(done).toBe(false);
    // Fully flushed now.
    s.writableLength = 0;
    s.emit("drain");
    await p;
    expect(done).toBe(true);
  });

  test("resolves on error so a reader that closed early (EPIPE) can't hang exit", async () => {
    const s = fakeStream(500);
    const p = waitForStreamDrain(s);
    s.emit("error", new Error("EPIPE"));
    await expect(p).resolves.toBeUndefined();
  });

  test("resolves on close as well", async () => {
    const s = fakeStream(500);
    const p = waitForStreamDrain(s);
    s.emit("close");
    await expect(p).resolves.toBeUndefined();
  });
});
