import type { ReferenceCatalog } from "@intentius/chant/lexicon";

/**
 * Fly reference catalog (#804) — how observed Fly resources reference each other,
 * so `chant graph --live` reconstructs the topology and draws the App as a
 * boundary box (the reference resolver, chant#778; containment, chant#779).
 *
 * Fly's relationships are app-centric and simple. `describeResources`
 * (./describe-resources.ts) already returns the rich per-resource shape — each
 * app-scoped resource carries its owning `app`, and a machine carries its full
 * `config` (with `mounts`) — so, unlike AWS (chant#784), Fly needs **no**
 * `enrichLiveAttrs`: the references are already in the observed attributes.
 *
 * Keyed to the `describeResources` attribute shape:
 *   - App        → `{ app }`           (physicalId = app name)
 *   - Machine    → `{ app, config }`   (config.mounts[].volume references a Volume)
 *   - Volume     → `{ app, volumeName }`
 *   - IPAddress  → `{ app, ... }`
 *   - Certificate→ `{ app, ... }`
 */
export const flyReferenceCatalog: ReferenceCatalog = {
  identities: [
    // The App is identified by its name (also its physicalId), which every
    // app-scoped resource carries in `app`.
    { kind: "Fly::Machines::App", ids: ["app"] },
    // A Volume is referenced by name; its id is already indexed via physicalId,
    // so a mount that names either resolves.
    { kind: "Fly::Machines::Volume", ids: ["volumeName"] },
  ],
  refs: [
    // Containment: everything app-scoped lives inside its App → a boundary box.
    { from: "Fly::Machines::Machine", path: "app", targetKind: "Fly::Machines::App", relation: "containment", label: "in app" },
    { from: "Fly::Machines::Volume", path: "app", targetKind: "Fly::Machines::App", relation: "containment", label: "in app" },
    { from: "Fly::Machines::IPAddress", path: "app", targetKind: "Fly::Machines::App", relation: "containment", label: "in app" },
    { from: "Fly::Machines::Certificate", path: "app", targetKind: "Fly::Machines::App", relation: "containment", label: "in app" },
    // Reference edge: a machine mount → the Volume it mounts.
    { from: "Fly::Machines::Machine", path: "config.mounts[].volume", targetKind: "Fly::Machines::Volume", relation: "reference", label: "mounts" },
  ],
};
