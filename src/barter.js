"use strict";

const A = require("./actions");
const H = require("./highway");
const E = require("./pearl");
const { Vec3 } = require("vec3");

const neededEyes = (eyes = 0) => Math.max(0, 12 - eyes);
const ingotsFromNuggets = (n) => Math.floor(n / 9);
const drops = (bot, name) => Object.values(bot.entities).filter(e => {
  if (e.name !== "item") return false;
  try { return e.getDroppedItem()?.name === name; } catch (_) { return false; }
});

async function mineGold(bot, wantNuggets, say = () => {}, opts = {}) {
  const end = Date.now() + (opts.maxMs || 240000), id = bot.registry.blocksByName.nether_gold_ore.id;
  while (Date.now() < end && A.count(bot, "gold_nugget") < wantNuggets) {
    const ores = bot.findBlocks({ matching: id, maxDistance: 48, count: 128 })
      .map(p => new Vec3(p.x, p.y, p.z)).filter(p => ![[0,0,0],[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]].some(([x,y,z]) => bot.blockAt(p.offset(x,y,z))?.name === "lava"))
      .sort((a,b) => a.distanceTo(bot.entity.position)-b.distanceTo(bot.entity.position));
    const ore = ores[0]; if (!ore) break;
    const r = await H.highway(bot, ore, { enclosed: true, range: 1, maxMs: Math.min(60000, end-Date.now()) });
    if (r !== "arrived") break;
    const b = bot.blockAt(ore); if (!b || b.name !== "nether_gold_ore") continue;
    try { await A.withHand(bot, async () => { const {item}=A.fastestTool(bot,b); if(item) await bot.equip(item,"hand"); await bot.dig(b,true); }); } catch (_) { continue; }
    await A.sleep(500); await A.collectDrops(bot, bot.entity.position, 4);
  }
  return A.count(bot,"gold_nugget");
}

async function barter(bot, needPearls, say = () => {}, opts = {}) {
  const t0=Date.now(), maxMs=opts.maxMs||360000, target=opts.bastion;
  if (target) await H.highway(bot,{x:target.x,y:target.y??bot.entity.position.y,z:target.z},{enclosed:true,range:16,maxMs:180000});
  await E.sealCapsule(bot);
  const start=A.count(bot,"gold_ingot"); let pending=[], last=Date.now();
  while(Date.now()-t0<maxMs && E.pearls(bot)<needPearls && A.count(bot,"gold_ingot")>0) {
    const me=bot.entity.position;
    pending=pending.filter(x=>bot.entities[x.id] || Date.now()-x.at<7000);
    const piglins=Object.values(bot.entities).filter(e=>e.name==="piglin"&&e.position.distanceTo(me)<12).sort((a,b)=>a.position.distanceTo(me)-b.position.distanceTo(me));
    const brutes=Object.values(bot.entities).filter(e=>["piglin_brute","hoglin"].includes(e.name)&&e.position.distanceTo(me)<6);
    if(pending.length<3&&piglins.length) {
      const p=piglins.find(e=>!pending.some(x=>x.piglin===e.id));
      if(p){
        const dx=Math.sign(p.position.x-me.x), dz=Math.sign(p.position.z-me.z);
        const wall=H.cellOf(bot).offset(dx,0,dz);
        const wb=bot.blockAt(wall);
        if(wb?.boundingBox==="block") {
          await A.withHand(bot,async()=>{const {item}=A.fastestTool(bot,wb);if(item)await bot.equip(item,"hand");await bot.dig(wb,true);});
          await bot.lookAt(p.position.offset(0,1,0),true);
          const item=bot.inventory.items().find(i=>i.name==="gold_ingot");
          if(item){await bot.toss(item.type,null,1);pending.push({id:null,piglin:p.id,at:Date.now()});pending[pending.length-1].id=drops(bot,"gold_ingot").sort((a,b)=>a.position.distanceTo(me)-b.position.distanceTo(me))[0]?.id;await A.sleep(1000);await H.placeFiller(bot,wall);}
        }
      }
    }
    await A.sleep(1000);
    if(Date.now()-last>=10000){last=Date.now();A.dbg(`Takas: ${E.pearls(bot)} pearl, ${A.count(bot,"gold_ingot")} külçe, ${piglins.length} piglin`);}
    if(brutes.length) await A.sleep(1000);
  }
  return {pearls:E.pearls(bot),ingotsUsed:start-A.count(bot,"gold_ingot"),ms:Date.now()-t0};
}

module.exports={mineGold,barter,neededEyes,ingotsFromNuggets};
