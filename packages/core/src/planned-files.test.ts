/** #4966: a product's planned files with their modes, and its stale generated files found by header. */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { planFile, planRemoval, staleGeneratedFiles, writePlannedFiles } from "./planned-files";

const dir = (): string => mkdtempSync(join(tmpdir(), "chant-planned-"));
const modeOf = (p: string): number => statSync(p).mode & 0o777;

describe("planFile and writePlannedFiles", () => {
  test("plans against the disk, writes the plan with its modes, and leaves an unchanged file alone", () => {
    const root = dir();
    const script = join(root, "bin", "run.sh");
    const config = join(root, "tool.yml");
    writeFileSync(config, "a: 1\n");
    const plan = [planFile(script, "#!/bin/sh\n", { mode: 0o755 }), planFile(config, "a: 1\n"), planFile(join(root, "new.txt"), "new\n")];
    expect(plan.map((f) => f.status)).toEqual(["created", "unchanged", "created"]);
    writePlannedFiles(plan);
    expect(readFileSync(script, "utf-8")).toBe("#!/bin/sh\n");
    expect(modeOf(script)).toBe(0o755);
    expect(readFileSync(join(root, "new.txt"), "utf-8")).toBe("new\n");
    expect(planFile(script, "#!/bin/sh\n", { mode: 0o755 }).status).toBe("unchanged");
  });

  test("a file whose content is the same and whose mode is not is updated", () => {
    const root = dir();
    const script = join(root, "run.sh");
    writeFileSync(script, "#!/bin/sh\n");
    chmodSync(script, 0o644);
    const plan = planFile(script, "#!/bin/sh\n", { mode: 0o755, local: true });
    expect(plan).toEqual({ path: script, status: "updated", content: "#!/bin/sh\n", mode: 0o755, local: true });
    writePlannedFiles([plan]);
    expect(modeOf(script)).toBe(0o755);
  });

  /** #5006: a product's byte files, such as terragucci's `registry edge` bundles, beside its text ones. */
  test("bytes are written unchanged and compared with the file byte for byte", () => {
    const root = dir();
    const zip = join(root, "edge", "bundle.zip");
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0xfe]);
    const files: { path: string; content: string | Buffer }[] = [
      { path: "worker.mjs", content: Buffer.from([0xef, 0xbb, 0xbf, 0x80]) },
      { path: "wrangler.toml", content: "name = \"r\"\n" },
    ];
    const plan = [planFile(zip, bytes), ...files.map((f) => planFile(join(root, "edge", f.path), f.content))];
    expect(plan.map((f) => f.status)).toEqual(["created", "created", "created"]);
    expect(plan[0].content).toBe(bytes);
    writePlannedFiles(plan);
    expect([...readFileSync(zip)]).toEqual([...bytes]);
    expect([...readFileSync(join(root, "edge", "worker.mjs"))]).toEqual([0xef, 0xbb, 0xbf, 0x80]);
    expect(readFileSync(join(root, "edge", "wrangler.toml"), "utf-8")).toBe("name = \"r\"\n");
    expect(planFile(zip, Buffer.from(bytes)).status).toBe("unchanged");
    expect(planFile(join(root, "edge", "worker.mjs"), files[0].content).status).toBe("unchanged");
    // A view into a larger buffer compares only its own bytes.
    const wider = new Uint8Array([9, ...bytes, 9]);
    expect(planFile(zip, wider.subarray(1, 1 + bytes.length)).status).toBe("unchanged");
    // 0xff and 0xfe both read as U+FFFD in UTF-8 text, so only a byte compare tells them apart.
    const odd = join(root, "odd.bin");
    writeFileSync(odd, Buffer.from([0xff]));
    expect(planFile(odd, "�").status).toBe("unchanged");
    expect(planFile(odd, new Uint8Array([0xfe])).status).toBe("updated");
    expect(planFile(odd, new Uint8Array([0xff, 0x00])).status).toBe("updated");
    const binary = planFile(odd, new Uint8Array([0xfe]), { mode: 0o600 });
    writePlannedFiles([binary]);
    expect([...readFileSync(odd)]).toEqual([0xfe]);
    expect(modeOf(odd)).toBe(0o600);
  });

  test("a removal is planned only for a file that is there, and written by unlinking it", () => {
    const root = dir();
    const old = join(root, "old.yml");
    writeFileSync(old, "x\n");
    expect(planRemoval(join(root, "absent.yml"))).toBeUndefined();
    const removal = planRemoval(old)!;
    expect(removal.status).toBe("removed");
    writePlannedFiles([removal, removal]);
    expect(existsSync(old)).toBe(false);
  });
});

describe("staleGeneratedFiles", () => {
  const HEADER = "# Rendered by tool ci from tool.config.ts.";

  test("lists the files that open with the header and are not rendered now, never a person's own", () => {
    const root = dir();
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    mkdirSync(join(root, ".forgejo", "workflows"), { recursive: true });
    writeFileSync(join(root, ".github/workflows/tool-pr.yml"), `${HEADER}\non: pull_request\n`);
    writeFileSync(join(root, ".github/workflows/tool-old.yml"), `${HEADER}\r\non: push\n`);
    writeFileSync(join(root, ".github/workflows/mine.yml"), "# my own\non: push\n");
    writeFileSync(join(root, ".github/workflows/notes.md"), `${HEADER}\n`);
    writeFileSync(join(root, ".forgejo/workflows/tool-pr.yml"), `${HEADER}\n`);
    writeFileSync(join(root, ".gitlab-ci.yml"), `${HEADER}\n`);
    const stale = staleGeneratedFiles({
      root,
      dirs: [".github/workflows", ".forgejo/workflows", ".gitlab"],
      files: [".gitlab-ci.yml"],
      match: /\.ya?ml$/,
      header: HEADER,
      rendered: [".github/workflows/tool-pr.yml"],
    });
    expect(stale).toEqual([".gitlab-ci.yml", ".github/workflows/tool-old.yml", ".forgejo/workflows/tool-pr.yml"]);
  });

  test("takes a test of the text in place of the header line", () => {
    const root = dir();
    writeFileSync(join(root, "a.yml"), "# generated by tool\n");
    writeFileSync(join(root, "b.yml"), "# hand-written\n");
    expect(staleGeneratedFiles({ root, dirs: ["."], header: (t) => t.includes("generated by tool"), rendered: [] })).toEqual(["a.yml"]);
    expect(staleGeneratedFiles({ root, files: ["a.yml", "b.yml", "c.yml"], header: (t) => t.includes("generated by tool"), rendered: [] })).toEqual(["a.yml"]);
  });
});
