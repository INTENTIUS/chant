/**
 * Re-export shim — `safeHeartbeat` now lives in core (`@intentius/chant/op`) so
 * both the temporal base activities and the relocated cloud appliers share one
 * implementation. Kept here so existing `./heartbeat` imports resolve unchanged.
 */
export { safeHeartbeat } from "@intentius/chant/op";
