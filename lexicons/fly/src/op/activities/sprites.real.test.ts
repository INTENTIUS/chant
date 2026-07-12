import { describe, test, expect } from "vitest";
import { spriteCreate, spriteExec, spriteDestroy, resolveSpritesEndpoint } from "./sprites";

// Real Sprites smoke test (#766), gated on `SPRITES_API_TOKEN`. Runs the WS exec
// client against the live control WebSocket at api.sprites.dev: create a
// uniquely-named sprite, exec `echo hi` (assert stdout + exit 0), exec
// `sh -c "exit 7"` (assert the exit code surfaces as 7), then destroy in a
// finally. Skips cleanly when the token is absent. The token is read from the
// environment only — never hardcode it.

const TOKEN = process.env.SPRITES_API_TOKEN;
const BASE = resolveSpritesEndpoint();

/** Poll the sprite until it reports `running` (or give up after `timeoutMs`). */
async function waitRunning(name: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/v1/sprites/${encodeURIComponent(name)}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    if (res.ok) {
      const b = (await res.json().catch(() => ({}))) as { status?: string };
      if (b.status === "running") return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

describe("real Sprites exec over the control WebSocket (gated on SPRITES_API_TOKEN)", () => {
  test.skipIf(!TOKEN)(
    "echo hi → exit 0; sh -c \"exit 7\" → exit 7",
    async () => {
      const name = `chant-it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        await spriteCreate({ name });
        await waitRunning(name);

        const ok = await spriteExec({ id: name, cmd: "echo hi" });
        expect(ok.exitCode).toBe(0);
        expect(ok.stdout).toContain("hi");

        // A non-zero exit throws; capture the surfaced exit code.
        let code: number | undefined;
        try {
          await spriteExec({ id: name, cmd: 'sh -c "exit 7"' });
        } catch (err) {
          code = Number((err as Error).message.match(/exited (\d+)/)?.[1]);
        }
        expect(code).toBe(7);
      } finally {
        await spriteDestroy({ id: name }).catch(() => {});
      }
    },
    120_000,
  );
});
