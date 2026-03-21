/**
 * FSx for Lustre PERSISTENT_2 — shared scratch storage.
 *
 * Why FSx Lustre over EFS:
 *   - EDA simulation jobs do parallel I/O across 50+ nodes simultaneously
 *   - FSx PERSISTENT_2 at 200 MB/s/TiB gives ~240 GB/s aggregate on 1200 GiB
 *   - Lustre is the standard at national labs (NERSC, ANL) and EDA shops
 *   - EFS burst credits cap out during sustained parallel I/O — Lustre doesn't
 *
 * Mount point: /scratch (configured in head-node UserData and compute launch template)
 */

import { FSxFileSystem } from "@intentius/chant-lexicon-aws";
import { privateSubnet1 } from "./networking";
import { fsxSg } from "./security";
import { config } from "./config";

export const scratchFs = new FSxFileSystem({
  FileSystemType: "LUSTRE",
  StorageCapacity: config.fsxStorageCapacityGiB,        // 1200 GiB (minimum for PERSISTENT_2)
  StorageType: "SSD",
  SubnetIds: [privateSubnet1.SubnetId],
  SecurityGroupIds: [fsxSg.GroupId],
  LustreConfiguration: {
    DeploymentType: "PERSISTENT_2",
    PerUnitStorageThroughput: config.fsxThroughputPerTiBMBps, // 200 MB/s/TiB = 240 GB/s total
    // DataCompressionType omitted — EDA waveform files compress well but CPU cost is measurable
  },
  Tags: [{ Key: "Name", Value: `${config.clusterName}-scratch` }],
});
