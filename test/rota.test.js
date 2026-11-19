'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { locateCoz, odaOzeti } = require('../kosu/rota')

test('locate yanıtındaki yaklaşık yükseklik null olur', () => {
  assert.deepEqual(locateCoz('The nearest minecraft:fortress is at [32, ~, 16] (35 blocks away)'), { x: 32, y: null, z: 16 })
})

test('locate yanıtındaki negatif koordinatlar çözülür', () => {
  assert.deepEqual(locateCoz('The nearest minecraft:warped_forest is at [-178, 49, 45] (45 blocks away)'), { x: -178, y: 49, z: 45 })
})

test('bulunamayan yapı null döner', () => {
  assert.equal(locateCoz('Could not find a structure of type minecraft:stronghold within reasonable distance'), null)
})

test('y koordinatı sayısal olduğunda korunur', () => {
  assert.deepEqual(locateCoz('The nearest minecraft:village_plains is at [100, 72, -20] (30 blocks away)'), { x: 100, y: 72, z: -20 })
})

test('portal çerçevelerinden merkez ve takılı göz sayısı hesaplanır', () => {
  const cerceveler = [
    { x: -1, y: 30, z: -1, eye: true }, { x: 0, y: 30, z: -1, eye: false }, { x: 1, y: 30, z: -1, eye: 'true' },
    { x: -1, y: 30, z: 0, eye: false }, { x: 1, y: 30, z: 0, eye: false },
    { x: -1, y: 30, z: 1, eye: false }, { x: 0, y: 30, z: 1, eye: false }, { x: 1, y: 30, z: 1, eye: false },
    { x: -2, y: 30, z: 0, eye: false }, { x: 2, y: 30, z: 0, eye: false },
    { x: 0, y: 30, z: -2, eye: false }, { x: 0, y: 30, z: 2, eye: false }
  ]
  assert.deepEqual(odaOzeti(cerceveler), { merkez: { x: 0, y: 30, z: 0 }, cerceve: 12, takiliGoz: 2 })
})

test('eksik portal halkası null döner', () => {
  assert.equal(odaOzeti([{ x: 0, y: 30, z: 0, eye: false }]), null)
})
