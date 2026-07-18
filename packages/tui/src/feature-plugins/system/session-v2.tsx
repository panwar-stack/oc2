import type { TuiPlugin, TuiPluginApi } from "@oc2-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { useSyncV2 } from "../../context/sync-v2"
import { SplitBorder } from "../../ui/border"
import { Spinner } from "../../component/spinner"
import { useTheme } from "../../context/theme"
import { useLocal } from "../../context/local"
import { reasoningSummary, useThinkingMode } from "../../context/thinking"
import { useRenderer, useTerminalDimensions, type JSX } from "@opentui/solid"
import { RGBA, TextAttributes, type BoxRenderable, type SyntaxStyle } from "@opentui/core"
import { useBindings } from "../../keymap"
import { Locale } from "../../util/locale"
import { useTuiPaths } from "../../context/runtime"
import { LANGUAGE_EXTENSIONS } from "../../util/filetype"
import { toolDisplayMetadata, webSearchProviderLabel } from "../../util/tool-display"
import path from "path"
import stripAnsi from "strip-ansi"
import type {
  SessionMessage,
  SessionMessageAgentSwitched,
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageCompaction,
  SessionMessageModelSwitched,
  SessionMessageShell,
  SessionMessageUser,
  ToolFileContent,
  ToolTextContent,
} from "@oc2-ai/sdk/v2"
import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { collapseToolOutput } from "../../util/collapse-tool-output"
import { setPreLayoutSiblingMargin } from "../../util/layout"
import { TranscriptUserMessage } from "../../component/user-message"
import { TurnFooter } from "../../component/turn-footer"
import { ThinkingRow } from "../../component/thinking-row"
import { ToolGroupHeader, ToolRow, v2ToolRowDuration } from "../../component/tool-row"

const id = "internal:session-v2-debug"
const route = "session.v2.messages"

function currentSessionID(api: TuiPluginApi) {
  const current = api.route.current
  if (current.name !== "session") return
  const sessionID = current.params?.sessionID
  return typeof sessionID === "string" ? sessionID : undefined
}

function View(props: { api: TuiPluginApi; sessionID: string }) {
  const sync = useSyncV2()
  const dimensions = useTerminalDimensions()
  const { theme, syntax, subtleSyntax } = useTheme()
  const messages = createMemo(() => sync.data.messages[props.sessionID] ?? [])
  const renderedMessages = createMemo(() => messages().toReversed())
  const lastAssistant = createMemo(() => renderedMessages().findLast((message) => message.type === "assistant"))
  const lastUserCreated = (index: number) =>
    renderedMessages()
      .slice(0, index)
      .findLast((message) => message.type === "user")?.time.created

  createEffect(() => {
    void sync.session.message.sync(props.sessionID)
  })

  useBindings(() => ({
    bindings: [
      {
        key: "escape",
        desc: "Back to session",
        group: "Session",
        cmd() {
          props.api.route.navigate("session", { sessionID: props.sessionID })
        },
      },
    ],
  }))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background}>
      <box flexDirection="row">
        <box flexGrow={1} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1}>
          <scrollbox
            viewportOptions={{ paddingRight: 0 }}
            verticalScrollbarOptions={{ visible: false }}
            stickyScroll={true}
            stickyStart="bottom"
            flexGrow={1}
          >
            <box height={1} />
            <Show when={messages().length === 0}>
              <MissingData label="Messages" detail="No v2 messages loaded from useSyncV2 yet." />
            </Show>
            <For each={renderedMessages()}>
              {(message, index) => (
                <Switch>
                  <Match when={message.type === "user"}>
                    <UserMessage message={message as SessionMessageUser} index={index()} />
                  </Match>
                  <Match when={message.type === "assistant"}>
                    <AssistantMessage
                      message={message as SessionMessageAssistant}
                      sessionID={props.sessionID}
                      last={lastAssistant()?.id === message.id}
                      syntax={syntax()}
                      subtleSyntax={subtleSyntax()}
                      start={lastUserCreated(index())}
                    />
                  </Match>
                  <Match when={message.type === "synthetic"}>
                    <></>
                  </Match>
                  <Match when={message.type === "system"}>
                    <></>
                  </Match>
                  <Match when={message.type === "shell"}>
                    <ShellMessage message={message as SessionMessageShell} />
                  </Match>
                  <Match when={message.type === "compaction"}>
                    <CompactionMessage message={message as SessionMessageCompaction} />
                  </Match>
                  <Match when={message.type === "agent-switched"}>
                    <AgentSwitchedMessage message={message as SessionMessageAgentSwitched} />
                  </Match>
                  <Match when={message.type === "model-switched"}>
                    <ModelSwitchedMessage message={message as SessionMessageModelSwitched} />
                  </Match>
                  <Match when={true}>
                    <UnknownMessage message={message} />
                  </Match>
                </Switch>
              )}
            </For>
          </scrollbox>
          <MissingData
            label="Session prompt, permission prompt, question prompt, sidebar"
            detail="The v2 message endpoint only exposes messages, so these session UI regions cannot be rendered here. Press Esc to return to the live session."
          />
        </box>
      </box>
    </box>
  )
}

function MissingData(props: { label: string; detail: string }) {
  const { theme } = useTheme()
  return (
    <box
      border={["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.warning}
      backgroundColor={theme.backgroundPanel}
      paddingLeft={2}
      paddingTop={1}
      paddingBottom={1}
      marginTop={1}
      flexShrink={0}
    >
      <text fg={theme.text}>
        <span style={{ bg: theme.warning, fg: theme.background, bold: true }}> MISSING DATA </span> {props.label}
      </text>
      <text fg={theme.textMuted}>{props.detail}</text>
    </box>
  )
}

function UserMessage(props: { message: SessionMessageUser; index: number }) {
  return (
    <TranscriptUserMessage
      id={props.message.id}
      marginTop={props.index === 0 ? 0 : 1}
      text={props.message.text}
      attachments={[
        ...(props.message.files ?? []).map((file) => ({ kind: file.mime, name: file.name ?? file.uri })),
        ...(props.message.agents ?? []).map((agent) => ({ kind: "agent", name: agent.name })),
      ]}
      meta={Locale.todayTimeOrDateTime(props.message.time.created)}
    />
  )
}

function ShellMessage(props: { message: SessionMessageShell }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const output = createMemo(() => stripAnsi(props.message.output.trim()))
  const [expanded, setExpanded] = createSignal(false)
  const maxLines = 10
  const maxChars = createMemo(() => maxLines * Math.max(20, dimensions().width - 6))
  const collapsed = createMemo(() => collapseToolOutput(output(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return output()
    return collapsed().output
  })
  return (
    <BlockTool
      title="# Shell"
      spinner={!props.message.time.completed}
      onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
    >
      <box gap={1}>
        <text fg={theme.text}>$ {props.message.command}</text>
        <Show when={output()}>
          <text fg={theme.text}>{limited()}</text>
        </Show>
        <Show when={collapsed().overflow}>
          <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
        </Show>
      </box>
    </BlockTool>
  )
}

function CompactionMessage(props: { message: SessionMessageCompaction }) {
  const { theme } = useTheme()
  return (
    <box
      marginTop={1}
      border={["top"]}
      title={props.message.reason === "auto" ? " Auto Compaction " : " Compaction "}
      titleAlignment="center"
      borderColor={theme.borderActive}
      flexShrink={0}
    />
  )
}

function AgentSwitchedMessage(props: { message: SessionMessageAgentSwitched }) {
  const { theme } = useTheme()
  const local = useLocal()
  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0}>
      <text>
        <span style={{ fg: local.agent.color(props.message.agent) }}>▣ </span>
        <span style={{ fg: theme.textMuted }}>Switched agent to </span>
        <span style={{ fg: theme.text }}>{Locale.titlecase(props.message.agent)}</span>
      </text>
    </box>
  )
}

function ModelSwitchedMessage(props: { message: SessionMessageModelSwitched }) {
  const { theme } = useTheme()
  const model = createMemo(() => {
    const variant = props.message.model.variant ? `/${props.message.model.variant}` : ""
    return `${props.message.model.providerID}/${props.message.model.id}${variant}`
  })
  return (
    <box paddingLeft={3} marginTop={1} flexShrink={0}>
      <text>
        <span style={{ fg: theme.secondary }}>◇ </span>
        <span style={{ fg: theme.textMuted }}>Switched model to </span>
        <span style={{ fg: theme.text }}>{model()}</span>
      </text>
    </box>
  )
}

function UnknownMessage(props: { message: SessionMessage }) {
  return <MissingData label="Unknown message type" detail={JSON.stringify(props.message)} />
}

function consecutiveV2Tools(items: SessionMessageAssistant["content"], start: number) {
  if (items[start]?.type !== "tool" || items[start - 1]?.type === "tool") return []
  const result: SessionMessageAssistantTool[] = []
  for (let index = start; index < items.length; index++) {
    const item = items[index]
    if (item?.type !== "tool") break
    result.push(item)
  }
  return result
}

function v2ToolError(part: SessionMessageAssistantTool) {
  return part.state.status === "error" ? part.state.error.message : undefined
}

function v2Interrupted(error: SessionMessageAssistant["error"]) {
  return Boolean(error && /abort|cancel|interrupt/i.test(error.message))
}

function AssistantMessage(props: {
  message: SessionMessageAssistant
  sessionID: string
  last: boolean
  syntax: SyntaxStyle
  subtleSyntax: SyntaxStyle
  start?: number
}) {
  const { theme } = useTheme()
  const local = useLocal()
  const [collapsedGroups, setCollapsedGroups] = createSignal<ReadonlySet<string>>(new Set())
  const duration = createMemo(() => {
    if (!props.message.time.completed) return 0
    return props.message.time.completed - (props.start ?? props.message.time.created)
  })
  const model = createMemo(() => {
    const variant = props.message.model.variant ? `/${props.message.model.variant}` : ""
    return `${props.message.model.providerID}/${props.message.model.id}${variant}`
  })
  const final = createMemo(() => props.message.finish && !["tool-calls", "unknown"].includes(props.message.finish))
  return (
    <>
      <For each={props.message.content}>
        {(part, index) => {
          const tools = createMemo(() => consecutiveV2Tools(props.message.content, index()))
          const groupKey = createMemo(() => {
            if (part.type !== "tool") return
            let cursor = index()
            while (cursor > 0 && props.message.content[cursor - 1]?.type === "tool") cursor--
            return props.message.content[cursor]?.id
          })
          const collapsed = createMemo(() => {
            const key = groupKey()
            return key ? collapsedGroups().has(key) : false
          })
          return (
            <>
              <Show when={tools().length > 0}>
                <ToolGroupHeader
                  name="Tools"
                  items={tools().map((item) => ({ status: item.state.status, error: v2ToolError(item) }))}
                  collapsed={collapsed()}
                  onCollapsedChange={(value) => {
                    const key = groupKey()
                    if (!key) return
                    setCollapsedGroups((current) => {
                      const next = new Set(current)
                      if (value) next.add(key)
                      else next.delete(key)
                      return next
                    })
                  }}
                />
              </Show>
              <Show when={!collapsed()}>
                <Switch>
                  <Match when={part.type === "text"}>
                    <AssistantText part={part as SessionMessageAssistantText} syntax={props.syntax} />
                  </Match>
                  <Match when={part.type === "reasoning"}>
                    <AssistantReasoning
                      part={part as SessionMessageAssistantReasoning}
                      subtleSyntax={props.subtleSyntax}
                      createdAt={props.message.time.created}
                      completedAt={() => props.message.time.completed}
                    />
                  </Match>
                  <Match when={part.type === "tool"}>
                    <AssistantTool part={part as SessionMessageAssistantTool} sessionID={props.sessionID} />
                  </Match>
                </Switch>
              </Show>
            </>
          )
        }}
      </For>
      <Show when={props.message.content.length === 0}>
        <MissingData label="Assistant content" detail={`Assistant message ${props.message.id} has no content items.`} />
      </Show>
      <Show when={props.message.error}>
        <box
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          backgroundColor={theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.error}
          flexShrink={0}
        >
          <text fg={theme.textMuted}>{props.message.error}</text>
        </box>
      </Show>
      <Show when={props.last || final() || props.message.error}>
        <TurnFooter
          agent={props.message.agent}
          model={model()}
          color={local.agent.color(props.message.agent)}
          duration={duration() ? Locale.duration(duration()) : undefined}
          tokens={
            props.message.tokens
              ? props.message.tokens.input +
                props.message.tokens.output +
                props.message.tokens.reasoning +
                props.message.tokens.cache.read +
                props.message.tokens.cache.write
              : undefined
          }
          interrupted={v2Interrupted(props.message.error)}
        />
      </Show>
    </>
  )
}

function AssistantText(props: { part: SessionMessageAssistantText; syntax: SyntaxStyle }) {
  const { theme } = useTheme()
  return (
    <Show when={props.part.text.trim()}>
      <box paddingLeft={3} marginTop={1} flexShrink={0} id={`text-${props.part.id}`}>
        <code
          filetype="markdown"
          drawUnstyledText={false}
          streaming={true}
          syntaxStyle={props.syntax}
          content={props.part.text.trim()}
          conceal={true}
          fg={theme.text}
        />
      </box>
    </Show>
  )
}

function AssistantReasoning(props: {
  part: SessionMessageAssistantReasoning
  subtleSyntax: SyntaxStyle
  createdAt: number
  completedAt: () => number | undefined
}) {
  const thinking = useThinkingMode()
  const content = createMemo(() => props.part.text.replace("[REDACTED]", "").trim())
  const inMinimal = createMemo(() => thinking.mode() === "hide")
  const isDone = createMemo(() => props.completedAt() !== undefined)
  const summary = createMemo(() => reasoningSummary(content()))
  const duration = createMemo(() => {
    const end = props.completedAt()
    return end === undefined ? undefined : Locale.duration(Math.max(0, end - props.createdAt))
  })

  return (
    <Show when={content()}>
      <ThinkingRow
        id={`text-${props.part.id}`}
        title={summary().title}
        trace={summary().body}
        running={!isDone()}
        duration={duration()}
        syntaxStyle={props.subtleSyntax}
        conceal
        expanded={inMinimal() ? undefined : true}
      />
    </Show>
  )
}

function AssistantTool(props: { part: SessionMessageAssistantTool; sessionID: string }) {
  const input = createMemo(() => toolInputRecord(props.part.state.input))
  const toolprops = {
    get input() {
      return input()
    },
    get metadata() {
      return toolDisplayMetadata(props.part.state)
    },
    get output() {
      return props.part.state.status === "pending" ? undefined : toolOutput(props.part.state.content)
    },
    sessionID: props.sessionID,
    part: props.part,
  }
  return (
    <Switch>
      <Match when={props.part.name === "bash"}>
        <Bash {...toolprops} />
      </Match>
      <Match when={props.part.name === "glob"}>
        <Glob {...toolprops} />
      </Match>
      <Match when={props.part.name === "read"}>
        <Read {...toolprops} />
      </Match>
      <Match when={props.part.name === "grep"}>
        <Grep {...toolprops} />
      </Match>
      <Match when={props.part.name === "webfetch"}>
        <WebFetch {...toolprops} />
      </Match>
      <Match when={props.part.name === "websearch"}>
        <WebSearch {...toolprops} />
      </Match>
      <Match when={props.part.name === "write"}>
        <Write {...toolprops} />
      </Match>
      <Match when={props.part.name === "edit"}>
        <Edit {...toolprops} />
      </Match>
      <Match when={props.part.name === "apply_patch"}>
        <ApplyPatch {...toolprops} />
      </Match>
      <Match when={props.part.name === "todowrite"}>
        <TodoWrite {...toolprops} />
      </Match>
      <Match when={props.part.name === "question"}>
        <Question {...toolprops} />
      </Match>
      <Match when={props.part.name === "skill"}>
        <Skill {...toolprops} />
      </Match>
      <Match when={props.part.name === "task"}>
        <Task {...toolprops} />
      </Match>
      <Match when={true}>
        <GenericTool {...toolprops} />
      </Match>
    </Switch>
  )
}

type ToolProps = {
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  output?: string
  sessionID: string
  part: SessionMessageAssistantTool
}

function GenericTool(props: ToolProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const output = createMemo(() => props.output?.trim() ?? "")
  const [expanded, setExpanded] = createSignal(false)
  const maxLines = 3
  const maxChars = createMemo(() => maxLines * Math.max(20, dimensions().width - 6))
  const collapsed = createMemo(() => collapseToolOutput(output(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return output()
    return collapsed().output
  })
  return (
    <Show
      when={output()}
      fallback={
        <InlineTool icon="⚙" pending="Writing command..." complete={toolComplete(props.part)} part={props.part}>
          {props.part.name}
        </InlineTool>
      }
    >
      <BlockTool
        title={`# ${props.part.name}`}
        part={props.part}
        onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
      >
        <box gap={1}>
          <text fg={theme.text}>{limited()}</text>
          <Show when={collapsed().overflow}>
            <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
          </Show>
        </box>
      </BlockTool>
    </Show>
  )
}

function InlineTool(props: {
  icon: string
  complete: unknown
  pending: string
  spinner?: boolean
  children: JSX.Element
  part: SessionMessageAssistantTool
}) {
  const dimensions = useTerminalDimensions()
  const input = createMemo(() => toolInputRecord(props.part.state.input))
  const metadata = createMemo(() => toolDisplayMetadata(props.part.state))
  return (
    <ToolRow
      id={`tool-inline-${props.part.id}`}
      width={dimensions().width}
      status={props.part.state.status}
      tool={props.part.name}
      name={v2ToolRowName(props.part.name)}
      input={input()}
      metadata={metadata()}
      duration={v2ToolRowDuration(props.part.time)}
      error={v2ToolError(props.part)}
      ref={(el: BoxRenderable) => {
        setPreLayoutSiblingMargin(el, (previous) => (previous?.id.startsWith("text-") ? 1 : 0))
      }}
    />
  )
}

function v2ToolRowName(tool: string) {
  if (tool === "bash") return "Shell"
  if (tool === "webfetch") return "Web Fetch"
  if (tool === "websearch") return "Web Search"
  if (tool === "apply_patch") return "Apply Patch"
  if (tool === "todowrite") return "Todo"
  return Locale.titlecase(tool)
}

function BlockTool(props: {
  title: string
  children: JSX.Element
  part?: SessionMessageAssistantTool
  onClick?: () => void
  spinner?: boolean
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const [hover, setHover] = createSignal(false)
  const input = createMemo(() => (props.part ? toolInputRecord(props.part.state.input) : {}))
  const metadata = createMemo(() => (props.part ? toolDisplayMetadata(props.part.state) : {}))
  return (
    <Show
      when={props.part}
      fallback={
        <box
          border={["left"]}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={2}
          marginTop={1}
          gap={1}
          backgroundColor={hover() ? theme.backgroundMenu : theme.backgroundPanel}
          customBorderChars={SplitBorder.customBorderChars}
          borderColor={theme.background}
          onMouseOver={() => props.onClick && setHover(true)}
          onMouseOut={() => setHover(false)}
          onMouseUp={() => {
            if (renderer.getSelection()?.getSelectedText()) return
            props.onClick?.()
          }}
          flexShrink={0}
        >
          <Show
            when={props.spinner}
            fallback={
              <text paddingLeft={3} fg={theme.textMuted}>
                {props.title}
              </text>
            }
          >
            <Spinner color={theme.textMuted}>{props.title.replace(/^# /, "")}</Spinner>
          </Show>
          {props.children}
        </box>
      }
    >
      {(part) => (
        <ToolRow
          id={`tool-block-${part().id}`}
          width={dimensions().width}
          status={part().state.status}
          tool={part().name}
          name={v2ToolRowName(part().name)}
          input={input()}
          metadata={metadata()}
          duration={v2ToolRowDuration(part().time)}
          error={v2ToolError(part())}
          ref={(el) => setPreLayoutSiblingMargin(el, (previous) => (previous?.id.startsWith("text-") ? 1 : 0))}
        >
          <box paddingTop={1} paddingBottom={1} gap={1}>
            {props.children}
          </box>
        </ToolRow>
      )}
    </Show>
  )
}

function Bash(props: ToolProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const output = createMemo(() => stripAnsi((stringValue(props.metadata.output) ?? props.output ?? "").trim()))
  const command = createMemo(() => stringValue(props.input.command) ?? pendingInput(props.part))
  const title = createMemo(() => `# ${stringValue(props.input.description) ?? "Shell"}`)
  const [expanded, setExpanded] = createSignal(false)
  const maxLines = 10
  const maxChars = createMemo(() => maxLines * Math.max(20, dimensions().width - 6))
  const collapsed = createMemo(() => collapseToolOutput(output(), maxLines, maxChars()))
  const limited = createMemo(() => {
    if (expanded() || !collapsed().overflow) return output()
    return collapsed().output
  })
  return (
    <Switch>
      <Match when={output()}>
        <BlockTool
          title={title()}
          part={props.part}
          spinner={props.part.state.status === "running"}
          onClick={collapsed().overflow ? () => setExpanded((prev) => !prev) : undefined}
        >
          <box gap={1}>
            <text fg={theme.text}>$ {command()}</text>
            <text fg={theme.text}>{limited()}</text>
            <Show when={collapsed().overflow}>
              <text fg={theme.textMuted}>{expanded() ? "Click to collapse" : "Click to expand"}</text>
            </Show>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="$" pending="Writing command..." complete={command()} part={props.part}>
          {command()}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Glob(props: ToolProps) {
  const normalizePath = usePathNormalizer()
  return (
    <InlineTool icon="✱" pending="Finding files..." complete={toolComplete(props.part)} part={props.part}>
      Glob "{stringValue(props.input.pattern) ?? pendingInput(props.part)}"{" "}
      <Show when={stringValue(props.input.path)}>in {normalizePath(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.count)}>
        {(count) => (
          <>
            ({count()} {count() === 1 ? "match" : "matches"})
          </>
        )}
      </Show>
    </InlineTool>
  )
}

function Read(props: ToolProps) {
  const normalizePath = usePathNormalizer()
  const { theme } = useTheme()
  const loaded = createMemo(() =>
    arrayValue(props.metadata.loaded).filter((item): item is string => typeof item === "string"),
  )
  return (
    <>
      <InlineTool
        icon="→"
        pending="Reading file..."
        complete={stringValue(props.input.filePath) ?? pendingInput(props.part)}
        spinner={props.part.state.status === "running"}
        part={props.part}
      >
        Read {normalizePath(stringValue(props.input.filePath) ?? pendingInput(props.part))}
      </InlineTool>
      <For each={loaded()}>
        {(filepath) => (
          <box paddingLeft={3} flexShrink={0}>
            <text paddingLeft={3} fg={theme.textMuted}>
              ↳ Loaded {normalizePath(filepath)}
            </text>
          </box>
        )}
      </For>
    </>
  )
}

function Grep(props: ToolProps) {
  const normalizePath = usePathNormalizer()
  return (
    <InlineTool icon="✱" pending="Searching content..." complete={toolComplete(props.part)} part={props.part}>
      Grep "{stringValue(props.input.pattern) ?? pendingInput(props.part)}"{" "}
      <Show when={stringValue(props.input.path)}>in {normalizePath(stringValue(props.input.path))} </Show>
      <Show when={numberValue(props.metadata.matches)}>
        {(matches) => (
          <>
            ({matches()} {matches() === 1 ? "match" : "matches"})
          </>
        )}
      </Show>
    </InlineTool>
  )
}

function WebFetch(props: ToolProps) {
  return (
    <InlineTool icon="%" pending="Fetching from the web..." complete={toolComplete(props.part)} part={props.part}>
      WebFetch {stringValue(props.input.url) ?? pendingInput(props.part)}
    </InlineTool>
  )
}

function WebSearch(props: ToolProps) {
  const label = createMemo(() => webSearchProviderLabel(props.metadata.provider))
  return (
    <InlineTool icon="◈" pending="Searching web..." complete={toolComplete(props.part)} part={props.part}>
      {label()} "{stringValue(props.input.query) ?? pendingInput(props.part)}"{" "}
      <Show when={numberValue(props.metadata.numResults)}>{(results) => <>({results()} results)</>}</Show>
    </InlineTool>
  )
}

function Write(props: ToolProps) {
  const normalizePath = usePathNormalizer()
  const { theme, syntax } = useTheme()
  const filePath = createMemo(() => stringValue(props.input.filePath) ?? "")
  const content = createMemo(() => stringValue(props.input.content) ?? "")
  return (
    <Switch>
      <Match when={content() && props.part.state.status === "completed"}>
        <BlockTool title={"# Wrote " + normalizePath(filePath())} part={props.part}>
          <line_number fg={theme.textMuted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme.text}
              filetype={filetype(filePath())}
              syntaxStyle={syntax()}
              content={content()}
            />
          </line_number>
          <Diagnostics diagnostics={props.metadata.diagnostics} filePath={filePath()} />
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing write..." complete={filePath()} part={props.part}>
          Write {normalizePath(filePath())}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Edit(props: ToolProps) {
  const normalizePath = usePathNormalizer()
  const { theme, syntax } = useTheme()
  const dimensions = useTerminalDimensions()
  const filePath = createMemo(() => stringValue(props.input.filePath) ?? "")
  const diff = createMemo(() => stringValue(props.metadata.diff))
  return (
    <Switch>
      <Match when={diff()}>
        {(diff) => (
          <BlockTool title={"← Edit " + normalizePath(filePath())} part={props.part}>
            <box paddingLeft={1}>
              <diff
                diff={diff()}
                view={dimensions().width > theme.diffSplitCols ? "split" : "unified"}
                filetype={filetype(filePath())}
                syntaxStyle={syntax()}
                showLineNumbers={true}
                width="100%"
                wrapMode="word"
                fg={theme.text}
                addedBg={theme.diffAddedBg}
                removedBg={theme.diffRemovedBg}
                contextBg={theme.diffContextBg}
                addedSignColor={theme.diffHighlightAdded}
                removedSignColor={theme.diffHighlightRemoved}
                lineNumberFg={theme.diffLineNumber}
                lineNumberBg={theme.diffContextBg}
                addedLineNumberBg={theme.diffAddedLineNumberBg}
                removedLineNumberBg={theme.diffRemovedLineNumberBg}
              />
            </box>
            <Diagnostics diagnostics={props.metadata.diagnostics} filePath={filePath()} />
          </BlockTool>
        )}
      </Match>
      <Match when={true}>
        <InlineTool icon="←" pending="Preparing edit..." complete={filePath()} part={props.part}>
          Edit {normalizePath(filePath())}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function ApplyPatch(props: ToolProps) {
  const normalizePath = usePathNormalizer()
  const { theme, syntax } = useTheme()
  const dimensions = useTerminalDimensions()
  const files = createMemo(() => arrayValue(props.metadata.files).flatMap((item) => (isRecord(item) ? [item] : [])))
  const fileTitle = (file: Record<string, unknown>) => {
    const type = stringValue(file.type)
    const relativePath = stringValue(file.relativePath) ?? stringValue(file.filePath) ?? "patch"
    if (type === "delete") return "# Deleted " + relativePath
    if (type === "add") return "# Created " + relativePath
    if (type === "move") return "# Moved " + normalizePath(stringValue(file.filePath)) + " → " + relativePath
    return "← Patched " + relativePath
  }
  return (
    <Switch>
      <Match when={files().length > 0}>
        <For each={files()}>
          {(file) => (
            <BlockTool title={fileTitle(file)} part={props.part}>
              <Show
                when={stringValue(file.patch)}
                fallback={
                  <text fg={theme.diffRemoved}>
                    -{numberValue(file.deletions) ?? 0} line{numberValue(file.deletions) === 1 ? "" : "s"}
                  </text>
                }
              >
                {(patch) => (
                  <box paddingLeft={1}>
                    <diff
                      diff={patch()}
                      view={dimensions().width > theme.diffSplitCols ? "split" : "unified"}
                      filetype={filetype(stringValue(file.filePath) ?? stringValue(file.relativePath))}
                      syntaxStyle={syntax()}
                      showLineNumbers={true}
                      width="100%"
                      wrapMode="word"
                      fg={theme.text}
                      addedBg={theme.diffAddedBg}
                      removedBg={theme.diffRemovedBg}
                      contextBg={theme.diffContextBg}
                      addedSignColor={theme.diffHighlightAdded}
                      removedSignColor={theme.diffHighlightRemoved}
                      lineNumberFg={theme.diffLineNumber}
                      lineNumberBg={theme.diffContextBg}
                      addedLineNumberBg={theme.diffAddedLineNumberBg}
                      removedLineNumberBg={theme.diffRemovedLineNumberBg}
                    />
                  </box>
                )}
              </Show>
            </BlockTool>
          )}
        </For>
      </Match>
      <Match when={true}>
        <InlineTool icon="%" pending="Preparing patch..." complete={false} part={props.part}>
          Patch
        </InlineTool>
      </Match>
    </Switch>
  )
}

function TodoWrite(props: ToolProps) {
  const { theme } = useTheme()
  const todos = createMemo(() => arrayValue(props.input.todos).flatMap((item) => (isRecord(item) ? [item] : [])))
  return (
    <Switch>
      <Match when={todos().length > 0 && props.part.state.status === "completed"}>
        <BlockTool title="# Todos" part={props.part}>
          <box>
            <For each={todos()}>
              {(todo) => (
                <text fg={theme.text}>
                  {todoIcon(stringValue(todo.status))} {stringValue(todo.content)}
                </text>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="⚙" pending="Updating todos..." complete={false} part={props.part}>
          Updating todos...
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Question(props: ToolProps) {
  const { theme } = useTheme()
  const questions = createMemo(() =>
    arrayValue(props.input.questions).flatMap((item) => (isRecord(item) ? [item] : [])),
  )
  const answers = createMemo(() => arrayValue(props.metadata.answers))
  return (
    <Switch>
      <Match when={answers().length > 0}>
        <BlockTool title="# Questions" part={props.part}>
          <box gap={1}>
            <For each={questions()}>
              {(question, index) => (
                <box>
                  <text fg={theme.textMuted}>{stringValue(question.question)}</text>
                  <text fg={theme.text}>{formatAnswer(answers()[index()])}</text>
                </box>
              )}
            </For>
          </box>
        </BlockTool>
      </Match>
      <Match when={true}>
        <InlineTool icon="→" pending="Asking questions..." complete={questions().length} part={props.part}>
          Asked {questions().length} question{questions().length === 1 ? "" : "s"}
        </InlineTool>
      </Match>
    </Switch>
  )
}

function Skill(props: ToolProps) {
  return (
    <InlineTool icon="→" pending="Loading skill..." complete={toolComplete(props.part)} part={props.part}>
      Skill "{stringValue(props.input.name) ?? pendingInput(props.part)}"
    </InlineTool>
  )
}

function Task(props: ToolProps) {
  const content = createMemo(() => {
    const description = stringValue(props.input.description)
    if (!description) return pendingInput(props.part)
    return `${Locale.titlecase(stringValue(props.input.subagent_type) ?? "General")} Task — ${description}`
  })
  return (
    <InlineTool
      icon="│"
      spinner={props.part.state.status === "running"}
      complete={toolComplete(props.part)}
      pending="Delegating..."
      part={props.part}
    >
      {content()}
    </InlineTool>
  )
}

function Diagnostics(props: { diagnostics: unknown; filePath: string }) {
  const normalizePath = usePathNormalizer()
  const { theme } = useTheme()
  const errors = createMemo(() => {
    if (!isRecord(props.diagnostics)) return []
    const value = props.diagnostics[normalizePath(props.filePath)] ?? props.diagnostics[props.filePath]
    return arrayValue(value)
      .flatMap((item) => (isRecord(item) ? [item] : []))
      .filter((diagnostic) => diagnostic.severity === 1)
      .slice(0, 3)
  })
  return (
    <Show when={errors().length}>
      <box>
        <For each={errors()}>
          {(diagnostic) => <text fg={theme.error}>Error {stringValue(diagnostic.message)}</text>}
        </For>
      </box>
    </Show>
  )
}

function toolOutput(content?: Array<ToolTextContent | ToolFileContent>) {
  return (content ?? [])
    .map((item) => {
      if (item.type === "text") return item.text.trim()
      const source =
        item.source.type === "data" ? "inline data" : item.source.type === "url" ? item.source.url : item.source.uri
      return `[file ${item.name ?? source}]`
    })
    .filter(Boolean)
    .join("\n")
}

function toolInputRecord(input: string | Record<string, unknown>) {
  if (typeof input === "string") return {}
  return input
}

function pendingInput(part: SessionMessageAssistantTool) {
  if (part.state.status !== "pending") return ""
  return part.state.input.trim()
}

function toolComplete(part: SessionMessageAssistantTool) {
  if (part.state.status === "pending") return pendingInput(part)
  return part.state.status === "completed" || part.state.status === "error" || part.state.status === "running"
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function usePathNormalizer() {
  const cwd = useTuiPaths().cwd
  return (input?: string) => normalizePath(input, cwd)
}

function normalizePath(input: string | undefined, cwd: string) {
  if (!input) return ""
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const relative = path.relative(cwd, absolute)
  if (!relative) return "."
  if (!relative.startsWith("..")) return relative
  return absolute
}

function filetype(input?: string) {
  if (!input) return "none"
  const language = LANGUAGE_EXTENSIONS[path.extname(input)]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

function todoIcon(status?: string) {
  if (status === "completed") return "✓"
  if (status === "in_progress") return "~"
  if (status === "cancelled") return "✕"
  return "☐"
}

function formatAnswer(answer: unknown) {
  if (!Array.isArray(answer)) return "(no answer)"
  if (answer.length === 0) return "(no answer)"
  return answer.filter((item): item is string => typeof item === "string").join(", ")
}

const tui: TuiPlugin = async (api) => {
  api.route.register([
    {
      name: route,
      render(input) {
        const sessionID = input.params?.sessionID
        if (typeof sessionID !== "string") {
          return <text fg={api.theme.current.error}>Missing sessionID</text>
        }
        return <View api={api} sessionID={sessionID} />
      },
    },
  ])

  api.keymap.registerLayer({
    commands: [
      {
        name: route,
        title: "View v2 session messages",
        category: "Debug",
        namespace: "palette",
        suggested: () => api.route.current.name === "session",
        enabled: () => api.route.current.name === "session",
        run() {
          const sessionID = currentSessionID(api)
          if (!sessionID) return
          api.route.navigate(route, { sessionID })
          api.ui.dialog.clear()
        },
      },
    ],
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
