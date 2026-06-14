export interface QueuedSessionInput {
  readonly id: string
  readonly text: string
  readonly createdAt: string
}

/** Minimal FIFO prompt queue used by one-shot session runs and future adapters. */
export class SessionInputQueue {
  private readonly inputs: QueuedSessionInput[] = []

  enqueue(text: string): QueuedSessionInput {
    const input = { id: crypto.randomUUID(), text, createdAt: new Date().toISOString() }
    this.inputs.push(input)
    return input
  }

  dequeue(): QueuedSessionInput | undefined {
    return this.inputs.shift()
  }

  get size(): number {
    return this.inputs.length
  }
}
