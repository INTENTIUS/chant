import { GcsBucket } from "@intentius/chant-lexicon-gcp";
import { cells, shared } from "../config";

export const artifactsBuckets = cells.map(c => GcsBucket({
  name: `${shared.projectId}-${c.name}-artifacts`,
  location: c.bucketLocation,
  versioning: true,
  lifecycleDeleteAfterDays: c.artifactRetentionDays > 0 ? c.artifactRetentionDays : undefined,
  lifecycleNearlineAfterDays: c.artifactRetentionDays > 0 ? 30 : undefined,
}));

export const registryBuckets = cells.map(c => GcsBucket({
  name: `${shared.projectId}-${c.name}-registry`,
  location: c.bucketLocation,
}));
