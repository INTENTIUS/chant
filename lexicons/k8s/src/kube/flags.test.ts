import { describe, test, expect } from "vitest";
import { parseKubeFlags, connectOptionsFrom, parseDurationSeconds, parseDurationMs } from "./flags";

describe("parseKubeFlags (chant #1079)", () => {
  test("splits positional args from the common flag set", () => {
    const { positional, values, flags } = parseKubeFlags(["deployment", "web", "-n", "prod", "-A"]);
    expect(positional).toEqual(["deployment", "web"]);
    expect(values.namespace).toBe("prod");
    expect(flags.allNamespaces).toBe(true);
  });

  test("accepts a joined --flag=value form (#1127 discipline)", () => {
    const { values } = parseKubeFlags(["--namespace=prod", "--output=json"]);
    expect(values).toEqual({ namespace: "prod", output: "json" });
  });

  test("merges a verb's own flag spec with the common set", () => {
    const { values, flags } = parseKubeFlags(["--tail", "50", "--previous"], {
      value: { "--tail": "tail" },
      boolean: { "--previous": "previous" },
    });
    expect(values.tail).toBe("50");
    expect(flags.previous).toBe(true);
  });

  test("an unrecognized flag throws the shared unknown-flag error", () => {
    expect(() => parseKubeFlags(["--bogus"])).toThrow(/Unknown flag: --bogus/);
  });

  test("a value flag given as a boolean via = throws (#1127)", () => {
    expect(() => parseKubeFlags(["--all-namespaces=yes"])).toThrow(/boolean flag/);
  });

  test("a value flag with nothing after it is an error, not a silent positional swallow", () => {
    expect(() => parseKubeFlags(["--namespace"])).toThrow(/requires a value/);
  });

  test("a bare '-' is a positional, not a flag (kubectl's stdin convention)", () => {
    const { positional } = parseKubeFlags(["apply", "-"]);
    expect(positional).toEqual(["apply", "-"]);
  });
});

describe("connectOptionsFrom", () => {
  test("maps env/context/kubeconfig to ConnectOptions", () => {
    expect(connectOptionsFrom({ env: "prod" })).toEqual({ environment: "prod" });
    expect(connectOptionsFrom({ context: "prod-eks" })).toEqual({ context: "prod-eks" });
    expect(connectOptionsFrom({ kubeconfig: "/tmp/kc" })).toEqual({ client: { kubeconfigPath: "/tmp/kc" } });
    expect(connectOptionsFrom({})).toEqual({});
  });
});

describe("parseDurationSeconds / parseDurationMs", () => {
  test("parses bare seconds and suffixed durations", () => {
    expect(parseDurationSeconds("45")).toBe(45);
    expect(parseDurationSeconds("45s")).toBe(45);
    expect(parseDurationSeconds("90m")).toBe(5400);
    expect(parseDurationSeconds("2h")).toBe(7200);
    expect(parseDurationMs("1h")).toBe(3_600_000);
  });

  test("rejects a nonsense duration", () => {
    expect(() => parseDurationSeconds("soon")).toThrow(/expected a duration/);
  });
});
