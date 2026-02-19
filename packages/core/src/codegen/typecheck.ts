/**
 * Type-check generated .d.ts files by spawning tsc.
 */
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export interface TypeCheckResult {
  ok: boolean;
  diagnostics: string[];
  fileCount: number;
}

/**
 * Type-check a .d.ts content string by writing to a temp file and running tsc.
 */
export async function typecheckDTS(content: string): Promise<TypeCheckResult> {
  // Create temp directory
  const dir = join(tmpdir(), `chant-typecheck-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });

  try {
    // Write the .d.ts file
    const dtsPath = join(dir, "index.d.ts");
    writeFileSync(dtsPath, content);

    // Write a minimal tsconfig
    const tsconfig = {
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        target: "ES2022",
        module: "ES2022",
        moduleResolution: "bundler",
      },
      include: ["index.d.ts"],
    };
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));

    // Run tsc
    const proc = Bun.spawn(["bunx", "tsc", "--noEmit", "--project", "tsconfig.json"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    // Parse diagnostics from stdout (tsc writes errors to stdout)
    const output = stdout + stderr;
    const diagnostics = output
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .filter((line) => /error TS\d+/.test(line) || /:\d+:\d+/.test(line));

    return {
      ok: exitCode === 0,
      diagnostics,
      fileCount: 1,
    };
  } finally {
    // Cleanup
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  }
}
