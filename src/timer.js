"use strict";

// Basit speedrun zamanlayıcısı: her aşama bitince "split" alır.
class Timer {
  constructor() {
    this.start = null;
    this.splits = [];
  }

  begin() {
    this.start = Date.now();
    this.last = this.start;
  }

  split(name) {
    const now = Date.now();
    const s = { name, total: now - this.start, segment: now - this.last };
    this.last = now;
    this.splits.push(s);
    console.log(`⏱  ${fmt(s.total)}  (+${fmt(s.segment)})  ${name}`);
    return s;
  }

  elapsed() {
    return this.start == null ? 0 : Date.now() - this.start;
  }

  table() {
    const rows = this.splits.map(
      (s) =>
        `  ${s.name.padEnd(28)} ${fmt(s.segment).padStart(9)} ${fmt(s.total).padStart(9)}`,
    );
    return ["  Aşama                         Süre    Toplam", ...rows].join(
      "\n",
    );
  }
}

function fmt(ms) {
  const m = Math.floor(ms / 60000);
  const s = ((ms % 60000) / 1000).toFixed(1);
  return m > 0 ? `${m}:${s.padStart(4, "0")}` : `${s}s`;
}

module.exports = { Timer, fmt };
