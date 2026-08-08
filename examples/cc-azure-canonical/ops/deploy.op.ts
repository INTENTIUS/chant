import { Op, phase, azApply } from "@intentius/chant-lexicon-temporal";

/**
 * The azure half's release path: direct per-resource ARM apply (floci-az has
 * no `Microsoft.Resources/deployments` provider, so there is no deployment
 * grouping to hand the template to — the applier PUTs each resource itself).
 * Apply only — the e2e harness owns the emulator lifecycle. The endpoint
 * defaults to the canonical floci-az port and yields to the ambient var the
 * harness exports, so the same Op serves both.
 */
export default Op({
  name: "cc-azure-deploy",
  overview: "azure CC round-trip: direct ARM apply to floci-az",
  taskQueue: "cc-azure-canonical",
  phases: [
    phase("Apply", [
      azApply("template.json", {
        resourceGroup: "local",
        location: "eastus",
        endpoint: process.env.AZURE_ENDPOINT_URL ?? "http://localhost:4577",
      }),
    ]),
  ],
});
