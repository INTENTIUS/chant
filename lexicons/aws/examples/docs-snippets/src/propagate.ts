import { propagate } from "@intentius/chant";
import { healthApi } from "./with-defaults";

export const api = propagate(
  healthApi,
  { Tags: [{ Key: "env", Value: "prod" }] },
);
