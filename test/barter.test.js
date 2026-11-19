"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const B=require("../src/barter");
test("takılı göz pearl ihtiyacını azaltır",()=>{assert.equal(B.neededEyes(3),9);assert.equal(B.neededEyes(12),0);});
test("nuggetler tam külçeye çevrilir",()=>{assert.equal(B.ingotsFromNuggets(17),1);assert.equal(B.ingotsFromNuggets(27),3);});
