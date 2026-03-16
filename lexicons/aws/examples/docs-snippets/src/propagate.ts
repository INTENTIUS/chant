import { propagate } from "@intentius/chant";
import { healthApi } from "./with-defaults";

export const propagatedApi = propagate(
  healthApi,
  { Tags: [{ Key: "env", Value: "prod" }] },
);
