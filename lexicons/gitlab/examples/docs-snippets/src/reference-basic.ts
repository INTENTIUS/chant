import * as _ from "./_";

export const deployRef = new _.Job({
  script: _.reference(".setup", "script"),
});
