const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { start, report } = require("../src/kazmaOlcer");

test("kazma ölçer başarılı kazıları alet ve aşamaya göre sayar", async () => {
  const bot = new EventEmitter();
  bot.heldItem = { name: "iron_pickaxe" };
  bot.dig = async (block) => block;
  start(bot, () => "test aşaması");
  await bot.dig({ name: "stone" });
  bot.heldItem = null;
  await bot.dig({ name: "dirt" });
  assert.match(report(), /test aşaması sonrası: 2 blok, el 1, alet iron_pickaxe:1,el:1/);
});

test("kazma ölçer '?' kovasını başlangıç olarak gösterir", async () => {
  const bot = new EventEmitter();
  bot.dig = async (block) => block;
  start(bot, () => "?");
  await bot.dig({ name: "netherrack" });
  assert.match(report(), /başlangıç: 1 blok, el 1, alet el:1/);
});
