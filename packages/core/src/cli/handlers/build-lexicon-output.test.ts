/**
 * `chant build --lexicon-output <lexicon>=<path>`: each named lexicon is built
 * into its own file, so one project can declare otel and prometheus. The build
 * itself is mocked; this checks how the handler splits the serializers and
 * the output paths.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";
import type { ParsedArgs, CommandContext } from "../registry";
import type { Serializer } from "../../serializer";

const buildCommandMock = vi.fn();

vi.mock("../commands/build", async () => {
  const actual = await vi.importActual<typeof import("../commands/build")>("../commands/build");
  return { ...actual, buildCommand: (...args: unknown[]) => buildCommandMock(...args) };
});

const { runBuild } = await import("./build");

const ser = (name: string) => ({ name }) as unknown as Serializer;

function ctx(overrides: Partial<ParsedArgs>, names = ["otel", "prometheus", "grafana"]): CommandContext {
  const args = {
    command: "build",
    path: ".",
    format: "",
    fix: false,
    watch: false,
    verbose: false,
    help: false,
    live: false,
    ...overrides,
  } as ParsedArgs;
  return { args, plugins: [], serializers: names.map(ser) } as unknown as CommandContext;
}

describe("runBuild --lexicon-output", () => {
  beforeEach(() => {
    buildCommandMock.mockReset().mockResolvedValue({ success: true, errors: [], warnings: [], resourceCount: 1, fileCount: 1 });
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  test("builds each named lexicon into its own file", async () => {
    const code = await runBuild(ctx({ lexiconOutput: ["otel=out/collector.yml", "prometheus=out/prometheus.yml"] }));
    expect(code).toBe(0);
    expect(buildCommandMock).toHaveBeenCalledTimes(2);
    const calls = buildCommandMock.mock.calls.map(([o]) => [o.serializers.map((s: Serializer) => s.name), o.output, o.format]);
    expect(calls).toEqual([
      [["otel"], "out/collector.yml", "yaml"],
      [["prometheus"], "out/prometheus.yml", "yaml"],
    ]);
  });

  test("lexicons not named go to --output when given, and are skipped otherwise", async () => {
    await runBuild(ctx({ lexiconOutput: ["otel=a.yml"], output: "rest.json" }));
    expect(buildCommandMock.mock.calls.map(([o]) => [o.serializers.map((s: Serializer) => s.name), o.output])).toEqual([
      [["otel"], "a.yml"],
      [["prometheus", "grafana"], "rest.json"],
    ]);
    buildCommandMock.mockClear();
    await runBuild(ctx({ lexiconOutput: ["otel=a.yml"] }));
    expect(buildCommandMock).toHaveBeenCalledTimes(1);
  });

  test("drops the 'No serializer found' warning for lexicons another file carries, and repeats nothing", async () => {
    const warn = "No serializer found for lexicon \"grafana\"";
    buildCommandMock.mockResolvedValue({ success: true, errors: [], warnings: [warn, "something else"], resourceCount: 1, fileCount: 1 });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await runBuild(ctx({ lexiconOutput: ["otel=a.yml", "prometheus=b.yml"] }));
    const printed = err.mock.calls.map((c) => String(c[0])).join("\n");
    expect(printed).not.toContain("No serializer found");
    expect(printed.match(/something else/g)).toHaveLength(1);
  });

  test("a failed build fails the command, and the other files are still written", async () => {
    buildCommandMock.mockResolvedValueOnce({ success: false, errors: ["boom"], warnings: [], resourceCount: 0, fileCount: 0 });
    const code = await runBuild(ctx({ lexiconOutput: ["otel=a.yml", "prometheus=b.yml"] }));
    expect(code).toBe(1);
    expect(buildCommandMock).toHaveBeenCalledTimes(2);
  });

  test("refuses a malformed spec, an unknown lexicon, a repeat, and --lexicon", async () => {
    for (const a of [
      { lexiconOutput: ["otel"] },
      { lexiconOutput: ["otel="] },
      { lexiconOutput: ["nope=a.yml"] },
      { lexiconOutput: ["otel=a.yml", "otel=b.yml"] },
      { lexiconOutput: ["otel=a.yml"], lexicon: "otel" },
    ]) {
      expect(await runBuild(ctx(a))).toBe(1);
    }
    expect(buildCommandMock).not.toHaveBeenCalled();
  });
});
