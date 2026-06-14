import type { SchedulerTaskPriority } from "./task"

/** Converts symbolic priorities into numeric queue weights while preserving custom weights. */
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
