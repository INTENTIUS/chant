import { output } from "@intentius/chant-lexicon-aws";
import { app } from "./main";

export const functionArn = output(app.func.Arn, "FunctionArn");
