'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { makePlan, clusters } = require('../src/planner')

const tree = (x, z, y = 64) => [0, 1, 2, 3, 4].map((i) => ({ x, y: y + i, z, name: 'oak_log' }))

test('clusters: birbirine değen blokları gruplar', () => {
  const g = clusters([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }])
  assert.strictEqual(g.length, 2)
})

test('makePlan: en yakın ağaç, demir ve elması seçer', () => {
  const resources = {
    log: [...tree(5, 5), ...tree(80, 80)],
    iron: [{ x: 10, y: 40, z: 10 }, { x: 11, y: 40, z: 10 }, { x: 11, y: 41, z: 10 },
      { x: 200, y: 40, z: 200 }, { x: 201, y: 40, z: 200 }, { x: 201, y: 41, z: 200 }],
    diamond: [{ x: 15, y: -58, z: 12, exposed: false }, { x: 16, y: -58, z: 12, exposed: false },
      { x: 300, y: -58, z: 300, exposed: true }],
    lava: []
  }
  const plan = makePlan(resources, { x: 0, y: 64, z: 0 }, { logsNeeded: 5 })
  assert.ok(plan.trees.every((p) => p.x === 5))
  assert.strictEqual(plan.iron.length, 3)
  assert.ok(plan.iron.every((p) => p.x < 20))
  assert.strictEqual(plan.diamonds.length, 2)
  assert.ok(plan.diamonds.every((p) => p.x < 20))
})

test('makePlan: lavın dibindeki elmastan kaçınır', () => {
  const resources = {
    log: tree(0, 0),
    iron: [{ x: 0, y: 30, z: 0 }, { x: 1, y: 30, z: 0 }, { x: 2, y: 30, z: 0 }],
    diamond: [{ x: 10, y: -58, z: 0 }, { x: 0, y: -58, z: 30 }],
    lava: [{ x: 11, y: -58, z: 0 }, { x: 9, y: -58, z: 0 }, { x: 10, y: -57, z: 0 }]
  }
  const plan = makePlan(resources, { x: 0, y: 64, z: 0 })
  assert.strictEqual(plan.diamonds[0].z, 30)
})

test('makePlan: elmas yoksa açıklama verir', () => {
  const plan = makePlan({ log: tree(0, 0), iron: [], diamond: [], lava: [] }, { x: 0, y: 64, z: 0 })
  assert.deepStrictEqual(plan.diamonds, [])
  assert.match(plan.reason, /elmas/)
})

test('makePlan: su içindeki demir yerine kuru olanı seçer', () => {
  const resources = {
    log: tree(0, 0),
    iron: [{ x: 5, y: 40, z: 0, wet: true }, { x: 6, y: 40, z: 0, wet: true }, { x: 7, y: 40, z: 0, wet: true },
      { x: 0, y: 40, z: 25 }, { x: 1, y: 40, z: 25 }, { x: 2, y: 40, z: 25 }],
    diamond: [{ x: 3, y: -58, z: 10 }],
    lava: []
  }
  const plan = makePlan(resources, { x: 0, y: 64, z: 0 })
  assert.ok(plan.iron.every((p) => p.z === 25))
})
