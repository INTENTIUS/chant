import { PseudoParameter, createPseudoParameters } from "@intentius/chant/pseudo-parameter";

export { PseudoParameter };

export const { ProjectId, Region, Zone } =
  createPseudoParameters({
    ProjectId: "GCP::ProjectId",
    Region: "GCP::Region",
    Zone: "GCP::Zone",
  });

/**
 * GCP namespace containing all pseudo-parameters.
 */
export const GCP = {
  ProjectId,
  Region,
  Zone,
} as const;
