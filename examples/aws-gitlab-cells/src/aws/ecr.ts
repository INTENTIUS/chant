// ECR repository with scan-on-push enabled.

import { ECRRepository, stackOutput } from "@intentius/chant-lexicon-aws";

export const repo = new ECRRepository({
  RepositoryName: "cells-app",
  ImageScanningConfiguration: {
    ScanOnPush: true,
  },
  ImageTagMutability: "IMMUTABLE",
});

export const repoUri = stackOutput(repo.RepositoryUri, {
  description: "ECR repository URI",
});
