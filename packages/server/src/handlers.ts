import { SessionV2 } from "@oc2-ai/core/session"
import { Database } from "@oc2-ai/core/database/database"
import { EventV2 } from "@oc2-ai/core/event"
import { LocationServiceMap } from "@oc2-ai/core/location-layer"
import { PermissionSaved } from "@oc2-ai/core/permission/saved"
import { ProjectV2 } from "@oc2-ai/core/project"
import { SessionProjector } from "@oc2-ai/core/session/projector"
import { SessionStore } from "@oc2-ai/core/session/store"
import { Layer } from "effect"
import { layer as locationLayer } from "./groups/location"
import { sessionLocationLayer } from "./middleware/session-location"
import { MessageHandler } from "./handlers/message"
import { ModelHandler } from "./handlers/model"
import { ProviderHandler } from "./handlers/provider"
import { SessionHandler } from "./handlers/session"
import { PermissionHandler } from "./handlers/permission"
import { FileSystemHandler } from "./handlers/fs"
import { CommandHandler } from "./handlers/command"
import { SkillHandler } from "./handlers/skill"
import { EventHandler } from "./handlers/event"
import { AgentHandler } from "./handlers/agent"
import { HealthHandler } from "./handlers/health"
import { QuestionHandler } from "./handlers/question"
import * as SessionExecutionLocal from "@oc2-ai/core/session/execution/local"

const sessionLayer = SessionV2.layer.pipe(
  Layer.provide(SessionProjector.layer),
  Layer.provide(SessionExecutionLocal.layer),
  Layer.provide(SessionStore.layer),
  Layer.provide(EventV2.layer),
  Layer.provide(Database.defaultLayer),
  Layer.provide(ProjectV2.defaultLayer),
  Layer.orDie,
)

export const handlers = Layer.mergeAll(
  HealthHandler,
  AgentHandler,
  SessionHandler,
  MessageHandler,
  ModelHandler,
  ProviderHandler,
  PermissionHandler,
  FileSystemHandler,
  CommandHandler,
  SkillHandler,
  EventHandler,
  QuestionHandler,
).pipe(
  Layer.provide(sessionLocationLayer),
  Layer.provide(locationLayer),
  Layer.provide(sessionLayer),
  Layer.provide(PermissionSaved.defaultLayer),
  Layer.provide(LocationServiceMap.layer),
)
