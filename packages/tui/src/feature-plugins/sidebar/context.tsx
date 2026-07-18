import type { TuiPlugin, TuiPluginApi } from "@oc2-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo } from "solid-js"
import { consumedTokens, currentContextMessage } from "../../util/context-usage"
import { SidebarContextSection } from "../../routes/session/sidebar-sections"

const id = "internal:sidebar-context"

function View(props: { api: TuiPluginApi; session_id: string }) {
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const session = createMemo(() => props.api.state.session.get(props.session_id))
  const cost = createMemo(() => session()?.cost ?? 0)

  const state = createMemo(() => {
    const last = currentContextMessage(msg())
    if (!last) {
      return {
        tokens: undefined,
        limit: undefined,
      }
    }

    const tokens = consumedTokens(last.tokens)
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      limit: model?.limit.context,
    }
  })

  return <SidebarContextSection tokens={state().tokens} limit={state().limit} cost={cost()} />
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
