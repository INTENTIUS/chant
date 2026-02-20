import { Sub, AWS } from "@intentius/chant-lexicon-aws";

export const endpoint = Sub`https://s3.${AWS.Region}.${AWS.URLSuffix}`;
