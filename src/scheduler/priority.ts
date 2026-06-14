import type { SchedulerTaskPriority } from "./task"

export const normalizePriority = (priority: SchedulerTaskPriority | number = "normal"): number => {
  if (typeof priority === "number") {
    return priority
  }
  if (priority === "high") {
    return 100
  }
  if (priority === "low") {
    return -100
  }
  return 0
}
