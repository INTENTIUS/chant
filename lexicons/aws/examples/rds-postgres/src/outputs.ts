import { output } from "@intentius/chant-lexicon-aws";
import { database } from "./database";

export const dbEndpoint = output(database.db.Endpoint_Address, "DbEndpoint");
