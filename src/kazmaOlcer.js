"use strict";

// Kazma kullanımını gözlemlemek için küçük, davranışı değiştirmeyen sayaç.
const A = require("./actions");

const stages = new Map();
let total = 0;
let hand = 0;
let breaks = 0;
let timer = null;
const records = [];

function bucket(stage) {
  if (!stages.has(stage)) stages.set(stage, { blocks: 0, hand: 0, tools: new Map() });
  return stages.get(stage);
}

function toolName(bot) {
  return bot.heldItem && bot.heldItem.name ? bot.heldItem.name : "el";
}

function start(bot, getStage = () => "?") {
  if (bot._kazmaOlcer) return;
  bot._kazmaOlcer = true;
  const original = bot.dig.bind(bot);
  bot.dig = async (...args) => {
    const block = args[0];
    const tool = toolName(bot);
    const tag = bot._digTag || (bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving() ? "pathfinder" : "?");
    const stage = getStage() || "?";
    const result = await original(...args);
    const b = bucket(stage);
    records.push({ stage, block: block && block.name ? block.name : "?", tool, caller: tag });
    b.blocks++;
    b.tools.set(tool, (b.tools.get(tool) || 0) + 1);
    total++;
    if (tool === "el") { hand++; b.hand++; }
    return result;
  };

  // Bir kazma tekli item olarak kaybolduysa ve son dayanıklılığına geldiyse kırılmıştır.
  const onSlot = (_slot, oldItem, newItem) => {
    if (!oldItem || newItem || !/_pickaxe$/.test(oldItem.name || "")) return;
    const max = oldItem.maxDurability || 0;
    if (max && oldItem.durabilityUsed >= max - 1) breaks++;
  };
  if (bot.inventory && bot.inventory.on) bot.inventory.on("updateSlot", onSlot); // mineflayer: (slot, eski, yeni)
  timer = setInterval(() => A.dbg("Kazma:", report().replace(/\n/g, " | ")), 60000);
  if (timer.unref) timer.unref();
}

function report() {
  const lines = [`Kazma: ${total} blok, el ${hand}, kırılan kazma ${breaks}`];
  for (const [stage, s] of stages) {
    const tools = [...s.tools].map(([name, n]) => `${name}:${n}`).join(",") || "-";
    lines.push(`  ${stage}: ${s.blocks} blok, el ${s.hand}, alet ${tools}`);
  }
  return lines.join("\n");
}

module.exports = { start, report };
