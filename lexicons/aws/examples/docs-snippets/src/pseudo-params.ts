import { Sub, AWS } from "@intentius/chant-lexicon-aws";

export const s3Endpoint = Sub`https://s3.${AWS.Region}.${AWS.URLSuffix}`;
