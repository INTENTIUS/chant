import { describe, test, expect } from "vitest";
import type { LexiconPlugin } from "../lexicon";
import {
  resolveCommandGroupVerb,
  collectCommandGroups,
  dispatchCommandGroup,
  formatCommandGroupsHelp,
  splitJoinedFlags,
  unknownFlagError,
  RESERVED_COMMAND_NAMES,
  type CommandGroup,
} from "./command-group";

const noopAsync = async () => {};

/** Minimal LexiconPlugin — only the fields relevant to a given test. */
function makePlugin(name: string, group?: CommandGroup): LexiconPlugin {
  const plugin: LexiconPlugin = {
    name,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    serializer: { name, serialize: () => "" } as any,
    generate: noopAsync,
    validate: noopAsync,
    coverage: noopAsync,
    package: noopAsync,
  };
  if (group) plugin.commands = () => group;
  return plugin;
}

function makeGroup(overrides: Partial<CommandGroup> = {}): CommandGroup {
  return {
    name: "kube",
    description: "Kubernetes verb group",
    commands: [
      { name: "get", description: "Get resources", handler: async () => 0 },
      { name: "version", description: "Print schema version", handler: async () => 0 },
    ],
    ...overrides,
  };
}

describe("resolveCommandGroupVerb", () => {
  test("mounts: finds the group and verb contributed by a plugin", () => {
    const group = makeGroup();
    const plugins = [makePlugin("k8s", group)];
    const result = resolveCommandGroupVerb(plugins, "kube", "get");
    expect(result.kind).toBe("matched");
    if (result.kind === "matched") {
      expect(result.plugin.name).toBe("k8s");
      expect(result.group).toBe(group);
      expect(result.command.name).toBe("get");
    }
  });

  test("no-capability lexicon is unaffected: a plugin with no commands() is skipped", () => {
    const plugins = [makePlugin("aws"), makePlugin("k8s", makeGroup())];
    const result = resolveCommandGroupVerb(plugins, "kube", "get");
    expect(result.kind).toBe("matched");
  });

  test("returns no-group when nothing claims the namespace", () => {
    const plugins = [makePlugin("aws"), makePlugin("gcp")];
    const result = resolveCommandGroupVerb(plugins, "kube", "get");
    expect(result.kind).toBe("no-group");
  });

  test("returns no-group for an empty plugin list", () => {
    expect(resolveCommandGroupVerb([], "kube", "get").kind).toBe("no-group");
  });

  test("returns unknown-verb when the group matches but the verb doesn't", () => {
    const plugins = [makePlugin("k8s", makeGroup())];
    const result = resolveCommandGroupVerb(plugins, "kube", "bogus");
    expect(result.kind).toBe("unknown-verb");
    if (result.kind === "unknown-verb") {
      expect(result.group.name).toBe("kube");
    }
  });

  test("returns no-verb when the group matches and no verb was given", () => {
    const plugins = [makePlugin("k8s", makeGroup())];
    const result = resolveCommandGroupVerb(plugins, "kube", undefined);
    expect(result.kind).toBe("no-verb");
  });

  test("never invokes a verb's handler while resolving — registration is data, not execution", () => {
    let invoked = false;
    const group: CommandGroup = {
      name: "kube",
      description: "d",
      commands: [{ name: "get", description: "d", handler: async () => { invoked = true; return 0; } }],
    };
    resolveCommandGroupVerb([makePlugin("k8s", group)], "kube", "get");
    expect(invoked).toBe(false);
  });
});

describe("collectCommandGroups", () => {
  test("lists groups from plugins in order; skips plugins without one", () => {
    const g1 = makeGroup({ name: "kube" });
    const g2 = makeGroup({ name: "flycmd", description: "Fly verb group" });
    const groups = collectCommandGroups([makePlugin("aws"), makePlugin("k8s", g1), makePlugin("fly", g2)]);
    expect(groups).toEqual([g1, g2]);
  });

  test("empty when no plugin contributes a group — an absent slot changes nothing", () => {
    expect(collectCommandGroups([makePlugin("aws"), makePlugin("gcp")])).toEqual([]);
  });
});

describe("dispatchCommandGroup", () => {
  test("dispatches: runs the matched verb's handler and returns its exit code", async () => {
    let seenCtx: unknown;
    const group: CommandGroup = {
      name: "kube",
      description: "d",
      commands: [
        {
          name: "get",
          description: "d",
          handler: async (ctx) => {
            seenCtx = ctx;
            return 3;
          },
        },
      ],
    };
    const result = await dispatchCommandGroup([makePlugin("k8s", group)], "kube", "get", ["pods", "-o", "wide"]);
    expect(result).toEqual({ kind: "ran", exitCode: 3 });
    expect(seenCtx).toEqual({ verb: "get", rawArgs: ["pods", "-o", "wide"] });
  });

  test("propagates a no-group result unchanged", async () => {
    const result = await dispatchCommandGroup([makePlugin("aws")], "kube", "get", []);
    expect(result).toEqual({ kind: "no-group" });
  });

  test("unknown verb produces a usage-error listing the group's real verbs", async () => {
    const result = await dispatchCommandGroup([makePlugin("k8s", makeGroup())], "kube", "bogus", []);
    expect(result.kind).toBe("usage-error");
    if (result.kind === "usage-error") {
      expect(result.message).toMatch(/Unknown kube subcommand: bogus/);
      expect(result.hint).toMatch(/get/);
      expect(result.hint).toMatch(/version/);
    }
  });

  test("bare group with no verb produces a usage-error, not a crash", async () => {
    const result = await dispatchCommandGroup([makePlugin("k8s", makeGroup())], "kube", undefined, []);
    expect(result.kind).toBe("usage-error");
    if (result.kind === "usage-error") {
      expect(result.message).toMatch(/Usage: chant kube <verb>/);
    }
  });
});

describe("formatCommandGroupsHelp", () => {
  test("composes group + verb listing for --help", () => {
    const text = formatCommandGroupsHelp([makeGroup()]);
    expect(text).toMatch(/Lexicon commands:/);
    expect(text).toMatch(/kube/);
    expect(text).toMatch(/get/);
    expect(text).toMatch(/version/);
  });

  test("empty string when there are no groups", () => {
    expect(formatCommandGroupsHelp([])).toBe("");
  });
});

describe("splitJoinedFlags (#1127 discipline, reused by mounted commands)", () => {
  test("splits a joined --flag=value token into two elements", () => {
    expect(splitJoinedFlags(["--format=json"])).toEqual(["--format", "json"]);
  });

  test("splits only at the first =, preserving a value that itself contains =", () => {
    expect(splitJoinedFlags(["--selector=env=prod"])).toEqual(["--selector", "env=prod"]);
  });

  test("leaves non-joined tokens untouched", () => {
    expect(splitJoinedFlags(["get", "pods", "-o", "wide"])).toEqual(["get", "pods", "-o", "wide"]);
  });

  test("throws when a declared boolean flag is given a joined value", () => {
    expect(() => splitJoinedFlags(["--watch=true"], new Set(["--watch"]))).toThrow(/--watch is a boolean flag/);
  });
});

describe("unknownFlagError (mounted-command unknown-flag error)", () => {
  test("produces the same 'Unknown flag' message shape core's own parser uses", () => {
    const err = unknownFlagError("--bogus");
    expect(err.message).toMatch(/^Unknown flag: --bogus/);
  });

  test("accepts a custom hint for the mounted command's own usage", () => {
    const err = unknownFlagError("--bogus", "chant kube version only accepts --format.");
    expect(err.message).toMatch(/only accepts --format/);
  });
});

describe("RESERVED_COMMAND_NAMES", () => {
  test("includes every core top-level word a lexicon must not shadow", () => {
    for (const name of ["build", "lint", "run", "emulator", "lifecycle", "components", "serve", "dev", "carve"]) {
      expect(RESERVED_COMMAND_NAMES.has(name)).toBe(true);
    }
  });
});
