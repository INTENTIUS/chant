// Static config for the alert-triage app — plain consts, resolved at synthesis.
// Replace the image refs with your own builds; they are pinned (chant lint flags
// `:latest`).
export const webhookImage = "ghcr.io/intentius/alert-webhook:0.1.0";
export const workerImage = "ghcr.io/intentius/alert-worker:0.1.0";
