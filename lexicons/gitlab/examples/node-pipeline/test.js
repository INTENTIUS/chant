const assert = require("assert");
const { hello } = require("./index");
assert.strictEqual(hello(), "world");
console.log("ok");
