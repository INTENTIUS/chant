import { output } from "@intentius/chant-lexicon-aws";
import { app } from "./main";

export const queueArn = output(app.queue.Arn, "QueueArn");
