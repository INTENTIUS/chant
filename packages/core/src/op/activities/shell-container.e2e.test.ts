/**
 * A `shell()` step in a container (#4015), run for real with `docker run
 * --rm`. Skipped when Docker is not running. The containers are `--rm` and
 * mount only host directories, so nothing is left behind.
 */
import { execSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { shellCmd } from "./shell";

// alpine 3.21, pinned by its index digest.
const IMAGE = process.env.CHANT_SHELL_E2E_IMAGE ?? "alpine:3.21@sha256:ce64758a109eb420d874a118f87920e625e12d3634e03b4a5573fd9f6e5d3507";

function available(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasDocker = available("docker info");
const skipReason = hasDocker ? "" : " (skipped: Docker is not running)";

describe.skipIf(!hasDocker)(`shellCmd with an image${skipReason}`, () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chant-shell-e2e-"));
    await writeFile(join(dir, "input.txt"), "from the host\n");
    execSync(`docker pull -q ${IMAGE}`, { stdio: "ignore" });
  }, 120_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("runs in the image, reads the workspace read-only, sees env by name, and writes its output directory on the host", async () => {
    process.env.CHANT_SHELL_E2E_HOST_ONLY = "leaked";
    try {
      const result = await shellCmd({
        cmd: 'cat /etc/alpine-release >/dev/null && echo "$GREETING:$CHANT_SHELL_E2E_HOST_ONLY" && cat input.txt > out/copy.txt; touch input.txt 2>/dev/null || echo read-only',
        image: IMAGE,
        cwd: dir,
        env: { GREETING: "hi" },
        outputs: ["out"],
      });
      expect(result.stdout.split("\n")).toEqual(["hi:", "read-only"]);
      expect(await readFile(join(dir, "out", "copy.txt"), "utf8")).toBe("from the host\n");
    } finally {
      delete process.env.CHANT_SHELL_E2E_HOST_ONLY;
    }
  }, 60_000);

  test("a declared output directory the command left empty fails the step", async () => {
    await expect(shellCmd({ cmd: "true", image: IMAGE, cwd: dir, outputs: ["empty"] })).rejects.toThrow(/left it empty/);
  }, 60_000);

  test("keeps the command's exit status, and okExit still applies", async () => {
    await expect(shellCmd({ cmd: "exit 4", image: IMAGE, cwd: dir })).rejects.toThrow(/command exited 4/);
    const ok = await shellCmd({ cmd: "echo done; exit 1", image: IMAGE, cwd: dir, okExit: [0, 1] });
    expect(ok).toMatchObject({ stdout: "done", exitCode: 1 });
  }, 60_000);
});
