export interface QueuedTask<TTask> {
  readonly sequence: number
  readonly priority: number
  readonly task: TTask
}

export interface TaskQueue<TTask> {
  enqueue(task: TTask, priority: number): boolean
  dequeue(): TTask | undefined
  remove(predicate: (task: TTask) => boolean): TTask[]
  readonly size: number
  readonly capacity: number
}

/** Creates a bounded priority queue that preserves FIFO order within the same priority. */
export const createTaskQueue = <TTask>(capacity: number): TaskQueue<TTask> => {
  let sequence = 0
  const tasks: QueuedTask<TTask>[] = []

  return {
    enqueue(task, priority) {
      if (tasks.length >= capacity) {
        return false
      }
      tasks.push({ task, priority, sequence })
      sequence += 1
      tasks.sort((left, right) => right.priority - left.priority || left.sequence - right.sequence)
      return true
    },

    dequeue() {
      return tasks.shift()?.task
    },

    remove(predicate) {
      const removed: TTask[] = []
      for (let index = tasks.length - 1; index >= 0; index -= 1) {
        if (predicate(tasks[index]!.task)) {
          removed.push(tasks[index]!.task)
          tasks.splice(index, 1)
        }
      }
      return removed
    },

    get size() {
      return tasks.length
    },

    get capacity() {
      return capacity
    },
  }
}
