import { describe, it, expect } from 'vitest'
import { RingBuffer } from './ring-buffer.js'

describe('RingBuffer', () => {
  it('stores and retrieves items in FIFO order', () => {
    const rb = new RingBuffer<number>(4)
    rb.push(1); rb.push(2); rb.push(3)
    expect(rb.shift()).toBe(1)
    expect(rb.shift()).toBe(2)
    expect(rb.size()).toBe(1)
  })

  it('overwrites oldest item when full (back-pressure: drop head)', () => {
    const rb = new RingBuffer<number>(3)
    rb.push(1); rb.push(2); rb.push(3)
    // Buffer full, next push overwrites oldest
    const dropped = rb.push(4)
    expect(dropped).toBe(1)   // returns dropped item
    expect(rb.shift()).toBe(2)
    expect(rb.shift()).toBe(3)
    expect(rb.shift()).toBe(4)
  })

  it('returns null when shifting empty buffer', () => {
    const rb = new RingBuffer<string>(4)
    expect(rb.shift()).toBeNull()
  })

  it('drainAll returns all items and empties buffer', () => {
    const rb = new RingBuffer<number>(8)
    rb.push(10); rb.push(20); rb.push(30)
    const drained = rb.drainAll()
    expect(drained).toEqual([10, 20, 30])
    expect(rb.size()).toBe(0)
  })

  it('isFull and isEmpty predicates work correctly', () => {
    const rb = new RingBuffer<number>(2)
    expect(rb.isEmpty()).toBe(true)
    rb.push(1)
    expect(rb.isEmpty()).toBe(false)
    rb.push(2)
    expect(rb.isFull()).toBe(true)
  })

  it('throws RangeError if capacity < 1', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError)
  })
})
