import { Sub, AWS, Topic } from "@intentius/chant-lexicon-aws";

export const alertTopic = new Topic({
  TopicName: Sub`${AWS.StackName}-alerts`,
});
