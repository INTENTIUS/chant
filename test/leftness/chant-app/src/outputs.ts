import { output } from "@intentius/chant-lexicon-aws";
import { itemsApi } from "./api";
import { itemsTable } from "./table";

export const apiEndpoint = output(itemsApi.ApiEndpoint, "ApiEndpoint");
export const tableArn = output(itemsTable.Arn, "TableArn");
