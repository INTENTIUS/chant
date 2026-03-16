import { output } from "@intentius/chant-lexicon-aws";
import { app } from "./main";

export const topicArn = output(app.topic.TopicArn, "TopicArn");
