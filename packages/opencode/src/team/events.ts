// Team event definitions, kept in their own module so consumers outside the team layer
// (lifecycle-reconciler, prompt.ts) can publish or subscribe to the same events without
// creating a module cycle through `team.ts` (which imports `run-state`).
import { EventV2 } from "@oc2-ai/core/event"
import { Schema } from "effect"

export const TeamCreated = EventV2.define({ type: "team.created", schema: { teamID: Schema.String } })
export const TeamClosed = EventV2.define({ type: "team.closed", schema: { teamID: Schema.String } })
export const MemberUpdated = EventV2.define({
  type: "team.member.updated",
  schema: {
    memberID: Schema.String,
    sessionID: Schema.String,
    status: Schema.String,
    lifecycle: Schema.optional(Schema.String),
    daemonState: Schema.optional(Schema.String),
  },
})
export const MessageReceived = EventV2.define({
  type: "team.message.received",
  schema: { messageID: Schema.String, teamID: Schema.String, sender: Schema.String },
})

export const TeamEvents = {
  created: TeamCreated,
  closed: TeamClosed,
  memberUpdated: MemberUpdated,
  messageReceived: MessageReceived,
}
