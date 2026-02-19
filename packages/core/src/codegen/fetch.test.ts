import { describe, test, expect } from "bun:test";
import { extractFromTar } from "./fetch";

/**
 * Build a minimal valid tar buffer with a single file entry.
 * Tar format: 512-byte header + data padded to 512-byte boundary + 1024 zero bytes (end marker).
 */
function buildTar(entries: Array<{ name: string; content: string; typeFlag?: string }>): Uint8Array {
  const blocks: Uint8Array[] = [];

  for (const entry of entries) {
    const header = new Uint8Array(512);
    const content = new TextEncoder().encode(entry.content);

    // Name (bytes 0-99)
    const nameBytes = new TextEncoder().encode(entry.name);
    header.set(nameBytes.slice(0, 100), 0);

    // Mode (bytes 100-107): "0000644\0"
    header.set(new TextEncoder().encode("0000644\0"), 100);

    // UID (bytes 108-115): "0000000\0"
    header.set(new TextEncoder().encode("0000000\0"), 108);

    // GID (bytes 116-123): "0000000\0"
    header.set(new TextEncoder().encode("0000000\0"), 116);

    // Size (bytes 124-135): octal, 11 chars + null
    const sizeOctal = content.length.toString(8).padStart(11, "0") + "\0";
    header.set(new TextEncoder().encode(sizeOctal), 124);

    // Mtime (bytes 136-147): "00000000000\0"
    header.set(new TextEncoder().encode("00000000000\0"), 136);

    // Type flag (byte 156): '0' for regular file
    header[156] = (entry.typeFlag ?? "0").charCodeAt(0);

    // Checksum (bytes 148-155): calculate sum of all header bytes with checksum field as spaces
    header.set(new TextEncoder().encode("        "), 148); // 8 spaces
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    const checksumStr = sum.toString(8).padStart(6, "0") + "\0 ";
    header.set(new TextEncoder().encode(checksumStr), 148);

    blocks.push(header);

    // Data blocks
    const dataBlocks = Math.ceil(content.length / 512);
    const dataBuffer = new Uint8Array(dataBlocks * 512);
    dataBuffer.set(content);
    blocks.push(dataBuffer);
  }

  // End-of-archive marker (two zero blocks)
  blocks.push(new Uint8Array(1024));

  const totalLength = blocks.reduce((sum, b) => sum + b.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const block of blocks) {
    result.set(block, offset);
    offset += block.length;
  }
  return result;
}

describe("extractFromTar", () => {
  test("extracts all regular files", () => {
    const tar = buildTar([
      { name: "file1.txt", content: "hello" },
      { name: "dir/file2.txt", content: "world" },
    ]);

    const files = extractFromTar(tar);
    expect(files.size).toBe(2);
    expect(files.get("file1.txt")!.toString()).toBe("hello");
    expect(files.get("dir/file2.txt")!.toString()).toBe("world");
  });

  test("applies filter", () => {
    const tar = buildTar([
      { name: "a.json", content: '{"a":1}' },
      { name: "b.txt", content: "text" },
      { name: "c.json", content: '{"c":3}' },
    ]);

    const files = extractFromTar(tar, (path) => path.endsWith(".json"));
    expect(files.size).toBe(2);
    expect(files.has("a.json")).toBe(true);
    expect(files.has("c.json")).toBe(true);
    expect(files.has("b.txt")).toBe(false);
  });

  test("skips directory entries", () => {
    const tar = buildTar([
      { name: "dir/", content: "", typeFlag: "5" },
      { name: "dir/file.txt", content: "content" },
    ]);

    const files = extractFromTar(tar);
    expect(files.size).toBe(1);
    expect(files.has("dir/file.txt")).toBe(true);
  });

  test("returns empty map for empty tar", () => {
    // Just end-of-archive marker
    const tar = new Uint8Array(1024);
    const files = extractFromTar(tar);
    expect(files.size).toBe(0);
  });

  test("handles files with various content", () => {
    const content = "abc\ndef\n";
    const tar = buildTar([{ name: "multi.txt", content }]);
    const files = extractFromTar(tar);
    expect(files.size).toBe(1);
    expect(files.get("multi.txt")!.toString()).toBe(content);
  });
});
