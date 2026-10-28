import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT_REAL_CLOUD, EXIT_REFUSED, runSafeRunCommand } from "./safe-run-cli";
import { parseArgs } from "../cli/parse-args";

const node = (script: string): string[] => [process.execPath, "-e", script];

describe("chant e2e safe-run", () => {
  let scratch: string;
  let out: string[];
  let err: string[];
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "safe-run-cli-test-"));
    out = [];
    err = [];
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  });
  afterEach(() => vi.restoreAllMocks());

  const base = { PATH: process.env.PATH, HOME: "/nonexistent" };

  test("runs the command with the scrubbed environment and prints CLEAN", async () => {
    const dump = join(scratch, "env.json");
    const code = await runSafeRunCommand({
      command: node(`require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env))`),
      scratch,
      echo: false,
      base: { ...base, GOOGLE_APPLICATION_CREDENTIALS: "/real/key.json", AWS_PROFILE: "prod", GOOGLE_CLOUD_PROJECT: "p", CLOUDSDK_CONFIG: "/home/me/.config/gcloud", PULUMI_ACCESS_TOKEN: "pul-x" },
    });
    expect(code).toBe(0);
    expect(out).toEqual(["CLEAN"]);
    const env = JSON.parse(readFileSync(dump, "utf8")) as Record<string, string>;
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined();
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
    expect(env.PULUMI_ACCESS_TOKEN).toBeUndefined();
    expect(env.CLOUDSDK_CONFIG).not.toBe("/home/me/.config/gcloud");
    expect(existsSync(env.CLOUDSDK_CONFIG)).toBe(true);
    expect(env.PULUMI_BACKEND_URL).toMatch(/^file:\/\//);
    expect(env.PULUMI_SKIP_UPDATE_CHECK).toBe("true");
  });

  test("keeps a local PULUMI_BACKEND_URL and refuses a remote one", async () => {
    const dump = join(scratch, "backend.txt");
    const script = `require("fs").writeFileSync(${JSON.stringify(dump)}, process.env.PULUMI_BACKEND_URL)`;
    expect(await runSafeRunCommand({ command: node(script), scratch, echo: false, base: { ...base, PULUMI_BACKEND_URL: "file:///tmp/mine" } })).toBe(0);
    expect(readFileSync(dump, "utf8")).toBe("file:///tmp/mine");
    expect(await runSafeRunCommand({ command: node(script), scratch, echo: false, base: { ...base, PULUMI_BACKEND_URL: "https://api.pulumi.com" } })).toBe(EXIT_REFUSED);
    expect(err.join("\n")).toContain("not a local backend");
  });

  test("passes the command's own exit code through after a CLEAN scan", async () => {
    expect(await runSafeRunCommand({ command: node("process.exit(7)"), scratch, echo: false, base })).toBe(7);
    expect(out).toEqual(["CLEAN"]);
  });

  test("rejects output where a real cloud refused a credential, and exits non-zero even when the command exits 0", async () => {
    const code = await runSafeRunCommand({
      command: node(`console.log("An error occurred (UnrecognizedClientException) when calling the ListBuckets operation")`),
      scratch,
      echo: false,
      base,
    });
    expect(code).toBe(EXIT_REAL_CLOUD);
    expect(out).not.toContain("CLEAN");
    expect(err.join("\n")).toContain("UnrecognizedClientException");
  });

  test("rejects a 401 from a cloud host in a --scan directory, and a missing --scan directory", async () => {
    const dir = join(scratch, "logs");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.log"), "GET https://storage.googleapis.com/b 401 Unauthorized\n");
    expect(await runSafeRunCommand({ command: node("0"), scratch, scan: [dir], echo: false, base })).toBe(EXIT_REAL_CLOUD);
    expect(err.join("\n")).toContain("a.log:1:");
    err.length = 0;
    expect(await runSafeRunCommand({ command: node("0"), scratch, scan: [join(scratch, "nope")], echo: false, base })).toBe(EXIT_REAL_CLOUD);
    expect(err.join("\n")).toContain("could not be checked");
  });

  test("a clean --scan directory passes", async () => {
    const dir = join(scratch, "clean");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.log"), "all good\n");
    expect(await runSafeRunCommand({ command: node("0"), scratch, scan: [dir], echo: false, base })).toBe(0);
  });

  test("a command that cannot start is a refusal, not a pass", async () => {
    expect(await runSafeRunCommand({ command: ["/nonexistent/fake-cmd"], scratch, echo: false, base })).toBe(EXIT_REFUSED);
  });

  test("parseArgs keeps the command after -- and collects each --scan", () => {
    const a = parseArgs(["e2e", "safe-run", "--scan", "a", "--scan", "b", "--", "bash", "-c", "echo hi", "--flag"]);
    expect(a.command).toBe("e2e");
    expect(a.path).toBe("safe-run");
    expect(a.scanDirs).toEqual(["a", "b"]);
    expect(a.positionals?.slice(1)).toEqual(["bash", "-c", "echo hi", "--flag"]);
    expect(() => parseArgs(["e2e", "safe-run", "--scan"])).toThrow(/--scan needs a directory/);
  });
});
