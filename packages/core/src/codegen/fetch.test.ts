import { describe, test, expect, vi, afterEach } from "vitest";
import { extractFromTar, fetchWithRetry, TransientFetchError } from "./fetch";

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

describe("fetchWithRetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const ok = () => new Response("payload", { status: 200 });
  const status = (code: number) => new Response("", { status: code });

  test("returns immediately on a successful response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);

    const resp = await fetchWithRetry("https://example.test/x", 4, 1);
    expect(resp.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("retries a transient status then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(status(504))
      .mockResolvedValueOnce(status(503))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    const resp = await fetchWithRetry("https://example.test/x", 4, 1);
    expect(resp.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("retries a network error then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    const resp = await fetchWithRetry("https://example.test/x", 4, 1);
    expect(resp.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("does not retry a permanent status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(status(404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWithRetry("https://example.test/x", 4, 1)).rejects.toThrow("returned 404");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("throws TransientFetchError after exhausting retries on a transient status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(status(504));
    vi.stubGlobal("fetch", fetchMock);

    const err = await fetchWithRetry("https://example.test/x", 2, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientFetchError);
    expect((err as TransientFetchError).url).toBe("https://example.test/x");
    expect((err as TransientFetchError).lastStatus).toBe(504);
    expect((err as TransientFetchError).message).toContain("Transient fetch failure");
    expect((err as TransientFetchError).message).toContain("HTTP 504");
    // initial attempt + 2 retries
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test("bounds an attempt with a signal even when no init is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);

    await fetchWithRetry("https://example.test/x", 4, 1);
    // A hung connect would otherwise wait on the OS default, which is long
    // enough to run a CI job past its timeout.
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/x",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  test("a caller's own signal wins over the attempt bound", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    await fetchWithRetry("https://example.test/x", 4, 1, { signal: controller.signal });
    expect(fetchMock.mock.calls[0][1].signal).toBe(controller.signal);
  });

  test("passes request init through to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok());
    vi.stubGlobal("fetch", fetchMock);

    const init = { headers: { Accept: "application/vnd.github+json" } };
    await fetchWithRetry("https://example.test/x", 4, 1, init);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test/x",
      expect.objectContaining({ headers: init.headers, signal: expect.any(AbortSignal) }),
    );
  });

  test("preserves init across retries on a transient status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(status(503))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    const init = { headers: { Accept: "application/vnd.github+json" } };
    const resp = await fetchWithRetry("https://example.test/x", 4, 1, init);
    expect(resp.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("https://example.test/x");
      expect(call[1]).toEqual(expect.objectContaining({ headers: init.headers, signal: expect.any(AbortSignal) }));
    }
  });

  test("does not retry a permanent status when init is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(status(403));
    vi.stubGlobal("fetch", fetchMock);

    const init = { headers: { Accept: "application/vnd.github+json" } };
    await expect(fetchWithRetry("https://example.test/x", 4, 1, init)).rejects.toThrow("returned 403");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("429 then 200 succeeds after retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(status(429))
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    const resp = await fetchWithRetry("https://example.test/x", 4, 1);
    expect(resp.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("honors Retry-After header (seconds) on 429", async () => {
    const sleepCalls: number[] = [];
    // Intercept sleep without really waiting
    vi.useFakeTimers();

    const r429 = new Response("", {
      status: 429,
      headers: { "Retry-After": "2" },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(r429)
      .mockResolvedValueOnce(ok());
    vi.stubGlobal("fetch", fetchMock);

    // Run with fake timers — advance all pending timers automatically
    const resultPromise = fetchWithRetry("https://example.test/x", 4, 1);
    await vi.runAllTimersAsync();
    const resp = await resultPromise;

    expect(resp.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
    void sleepCalls;
  });

  test("throws TransientFetchError with clear message on persistent 429", async () => {
    const r429 = new Response("", { status: 429 });
    const fetchMock = vi.fn().mockResolvedValue(r429);
    vi.stubGlobal("fetch", fetchMock);

    const err = await fetchWithRetry("https://example.test/rate-limited", 2, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientFetchError);
    const tfe = err as TransientFetchError;
    expect(tfe.url).toBe("https://example.test/rate-limited");
    expect(tfe.lastStatus).toBe(429);
    expect(tfe.message).toContain("Transient fetch failure");
    expect(tfe.message).toContain("HTTP 429");
    expect(tfe.message).toContain("rate-limit or upstream outage");
    expect(tfe.name).toBe("TransientFetchError");
  });

  test("throws TransientFetchError with clear message on persistent 5xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(status(503));
    vi.stubGlobal("fetch", fetchMock);

    const err = await fetchWithRetry("https://example.test/unavailable", 1, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientFetchError);
    const tfe = err as TransientFetchError;
    expect(tfe.lastStatus).toBe(503);
    expect(tfe.message).toContain("HTTP 503");
  });

  test("TransientFetchError message includes attempt count", async () => {
    const fetchMock = vi.fn().mockResolvedValue(status(500));
    vi.stubGlobal("fetch", fetchMock);

    // 0 retries → exactly 1 attempt
    const err = await fetchWithRetry("https://example.test/x", 0, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransientFetchError);
    expect((err as TransientFetchError).message).toContain("1 attempt");
  });
});
