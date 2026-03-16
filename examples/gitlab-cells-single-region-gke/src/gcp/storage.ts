import { GcsBucket } from "@intentius/chant-lexicon-gcp";
import { cells, shared } from "../config";

export const artifactsBuckets = cells.map(c => GcsBucket({
  name: `${shared.projectId}-${c.name}-artifacts`,
  location: c.bucketLocation,
  versioning: true,
  lifecycleDeleteAfterDays: c.artifactRetentionDays > 0 ? c.artifactRetentionDays : undefined,
  lifecycleNearlineAfterDays: c.artifactRetentionDays > 0 ? 30 : undefined,
}));

export const uploadsBuckets = cells.map(c => GcsBucket({
  name: `${shared.projectId}-${c.name}-uploads`,
  location: c.bucketLocation,
  versioning: true,
}));

export const lfsBuckets = cells.map(c => GcsBucket({
  name: `${shared.projectId}-${c.name}-lfs`,
  location: c.bucketLocation,
  versioning: true,
}));

export const packagesBuckets = cells.map(c => GcsBucket({
  name: `${shared.projectId}-${c.name}-packages`,
  location: c.bucketLocation,
  versioning: true,
  lifecycleDeleteAfterDays: c.artifactRetentionDays > 0 ? c.artifactRetentionDays : undefined,
}));

export const registryBuckets = cells.map(c => GcsBucket({
  name: `${shared.projectId}-${c.name}-registry`,
  location: c.bucketLocation,
}));
