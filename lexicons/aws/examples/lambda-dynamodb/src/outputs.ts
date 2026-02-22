import { output } from "@intentius/chant-lexicon-aws";
import { app } from "./main";

export const tableArn = output(app.table.Arn, "TableArn");
