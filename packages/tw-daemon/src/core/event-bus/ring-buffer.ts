/**
 * Fixed-capacity circular buffer (ring buffer).
 * When full, push() overwrites the oldest item and returns it.
 * O(1) push and shift. Zero dynamic allocation after construction.
 */
export class RingBuffer<T> {
  private readonly buf: (T | undefined)[]
  private head = 0   // next read position
  private tail = 0   // next write position
  private count = 0

  constructor(private readonly capacity: number) {
    if (capacity < 1) throw new RangeError('RingBuffer capacity must be >= 1')
    this.buf = new Array(capacity)
  }

  push(item: T): T | null {
    let dropped: T | null = null
    if (this.count === this.capacity) {
      // overwrite oldest: advance head, record dropped
      dropped = this.buf[this.head] as T
      this.head = (this.head + 1) % this.capacity
    } else {
      this.count++
    }
    this.buf[this.tail] = item
    this.tail = (this.tail + 1) % this.capacity
    return dropped
  }

  shift(): T | null {
    if (this.count === 0) return null
    const item = this.buf[this.head] as T
    this.buf[this.head] = undefined
    this.head = (this.head + 1) % this.capacity
    this.count--
    return item
  }

  drainAll(): T[] {
    const result: T[] = []
    let item: T | null
    while ((item = this.shift()) !== null) result.push(item)
    return result
  }

  size(): number { return this.count }
  isEmpty(): boolean { return this.count === 0 }
  isFull(): boolean { return this.count === this.capacity }
}
