import { ECRRepository, ECRRepository_ImageScanningConfiguration } from "@intentius/chant-lexicon-aws";

// chant-disable-next-line COR004
export const apiRepo = new ECRRepository({
  RepositoryName: "alb-api",
  ImageScanningConfiguration: new ECRRepository_ImageScanningConfiguration({
    ScanOnPush: true,
  }),
});

// chant-disable-next-line COR004
export const uiRepo = new ECRRepository({
  RepositoryName: "alb-ui",
  ImageScanningConfiguration: new ECRRepository_ImageScanningConfiguration({
    ScanOnPush: true,
  }),
});
