/**
 * Single source of truth for the Fly emulator image pins (#808 T2).
 *
 * mudflaps (Machines API) and spritzer (Sprites API) are the local fakes fly's
 * activities are exercised against. These tags were previously duplicated across
 * flaps.ts, sprites-emulator.ts, the fly-deploy composite, and tests — and had
 * already drifted (the composite's docstring said mudflaps 0.3.0 while the
 * activity pinned 0.3.1). Pin each here so a bump touches one line and the
 * emulator-freshness check (#808 T2) has a single target to compare against the
 * latest GHCR release.
 *
 * Bump policy (#808): move these only when a consuming test needs a newer
 * emulator (a fidelity fix the activities exercise), not on every emulator
 * release. For new upstream API surface the emulator leads, then fly bumps here.
 */

/** Pinned mudflaps (Fly Machines / flaps emulator) image. */
export const MUDFLAPS_IMAGE = "ghcr.io/intentius/mudflaps:0.4.1";

/** Pinned spritzer (Fly Sprites emulator) image. */
export const SPRITZER_IMAGE = "ghcr.io/intentius/spritzer:0.4.1";

/**
 * Pinned spritzer image for container exec mode (`SPRITZER_EXEC=container`,
 * #2711 / INTENTIUS/spritzer#22) — the Services CRUD activities
 * (`./sprite-services.ts`) and `spriteUrl` only exist in this mode (real
 * processes, a real sprite URL); the default `SPRITZER_IMAGE` above stays on
 * the interpreter-mode pin everything else is tested against. 0.6.0 is the
 * first release with container mode at all, so this can't move to a shared
 * pin until interpreter mode also needs 0.6.0 for something else (#808 bump
 * policy).
 */
export const SPRITZER_CONTAINER_IMAGE = "ghcr.io/intentius/spritzer:0.6.0";
