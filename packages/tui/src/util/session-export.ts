import type { OpencodeClient, Session as ClientSession, SessionMessagesResponse } from "@opencode-ai/sdk/v2"

export type ExportSessionNode<TInfo extends { id: string; time: { created: number } }, TMessage> = {
  info: TInfo
  messages: TMessage[]
  children: ExportSessionNode<TInfo, TMessage>[]
}

export type ExportSession = ExportSessionNode<ClientSession, SessionMessagesResponse[number]>

export type ExportSessionCollector<TInfo extends { id: string; time: { created: number } }, TMessage> = {
  get: (sessionID: string) => Promise<TInfo>
  messages: (sessionID: string) => Promise<TMessage[]>
  children: (sessionID: string) => Promise<TInfo[]>
}

export function collectExportSessionFromClient(
  client: Pick<OpencodeClient, "session">,
  sessionID: string,
): Promise<ExportSession> {
  return collectExportSessionAsync(
    {
      get: async (sessionID) => (await client.session.get({ sessionID }, { throwOnError: true })).data,
      messages: async (sessionID) => (await client.session.messages({ sessionID }, { throwOnError: true })).data,
      children: async (sessionID) => (await client.session.children({ sessionID }, { throwOnError: true })).data,
    },
    sessionID,
  )
}

export async function collectExportSessionAsync<TInfo extends { id: string; time: { created: number } }, TMessage>(
  collector: ExportSessionCollector<TInfo, TMessage>,
  sessionID: string,
): Promise<ExportSessionNode<TInfo, TMessage>> {
  const [info, messages, children] = await Promise.all([
    collector.get(sessionID),
    collector.messages(sessionID),
    collector.children(sessionID),
  ])

  return {
    info,
    messages,
    children: await Promise.all(
      children
        .toSorted((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
        .map((child) => collectExportSessionAsync(collector, child.id)),
    ),
  }
}
