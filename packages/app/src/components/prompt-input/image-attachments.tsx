import { Component, For, Show } from "solid-js"
import { Icon } from "@oc2-ai/ui/icon"
import { Tooltip } from "@oc2-ai/ui/tooltip"
import { StatusGlyph } from "@oc2-ai/ui/v2/status-glyph"
import type { ImageAttachmentPart } from "@/context/prompt"

type PromptImageAttachmentsProps = {
  attachments: ImageAttachmentPart[]
  onOpen: (attachment: ImageAttachmentPart) => void
  onRemove: (id: string) => void
  removeLabel: string
  pending?: { id: string; filename: string }[]
  uploadingLabel?: (filename: string) => string
  redesigned?: boolean
}

const fallbackClass = "size-16 rounded-md bg-surface-base flex items-center justify-center border border-border-base"
const imageClass =
  "size-16 rounded-md object-cover border border-border-base hover:border-border-strong-base transition-colors"
const removeClass =
  "absolute -top-1.5 -right-1.5 size-5 rounded-full bg-surface-raised-stronger-non-alpha border border-border-base flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-surface-raised-base-hover"
const nameClass = "absolute bottom-0 left-0 right-0 px-1 py-0.5 bg-black/50 rounded-b-md"

export const PromptImageAttachments: Component<PromptImageAttachmentsProps> = (props) => {
  return (
    <Show when={props.attachments.length > 0 || (props.pending?.length ?? 0) > 0}>
      <Show
        when={props.redesigned}
        fallback={
          <div class="flex flex-wrap gap-2 px-3 pt-3">
            <For each={props.attachments}>
              {(attachment) => (
                <Tooltip value={attachment.filename} placement="top" contentClass="break-all">
                  <div class="relative group">
                    <Show
                      when={attachment.mime.startsWith("image/")}
                      fallback={
                        <div class={fallbackClass}>
                          <Icon name="folder" class="size-6 text-text-weak" />
                        </div>
                      }
                    >
                      <img
                        src={attachment.dataUrl}
                        alt={attachment.filename}
                        class={imageClass}
                        onClick={() => props.onOpen(attachment)}
                      />
                    </Show>
                    <button
                      type="button"
                      onClick={() => props.onRemove(attachment.id)}
                      class={removeClass}
                      aria-label={props.removeLabel}
                    >
                      <Icon name="close" class="size-3 text-text-weak" />
                    </button>
                    <div class={nameClass}>
                      <span class="text-10-regular text-white truncate block">{attachment.filename}</span>
                    </div>
                  </div>
                </Tooltip>
              )}
            </For>
            <For each={props.pending ?? []}>
              {(attachment) => (
                <div
                  role="status"
                  aria-live="polite"
                  class="flex h-8 max-w-[220px] items-center gap-1.5 rounded-md border border-border-base bg-background-stronger px-2 text-12-regular text-text-weak"
                >
                  <StatusGlyph name="running" size="small" />
                  <span class="truncate">{props.uploadingLabel?.(attachment.filename) ?? attachment.filename}</span>
                </div>
              )}
            </For>
          </div>
        }
      >
        <div
          data-component="prompt-attachment-chips"
          class="flex flex-nowrap items-center gap-2 overflow-x-auto px-3 pt-3 no-scrollbar"
        >
          <For each={props.attachments}>
            {(attachment) => (
              <div class="group flex h-7 max-w-[220px] shrink-0 items-center gap-1 rounded-[var(--v2-radius-chip)] border border-v2-border-border-strong bg-v2-background-bg-layer-01 pl-2 pr-1 text-[var(--v2-font-size-meta)] hover:bg-v2-background-bg-layer-03 focus-within:border-v2-border-border-focus">
                <button
                  type="button"
                  class="flex min-w-0 items-center gap-1.5 text-v2-text-text-base outline-none"
                  onClick={() => props.onOpen(attachment)}
                  disabled={!attachment.mime.startsWith("image/")}
                  tabIndex={attachment.mime.startsWith("image/") ? undefined : -1}
                >
                  <StatusGlyph name="attachment" size="small" />
                  <span class="truncate">{attachment.filename}</span>
                </button>
                <button
                  type="button"
                  class="flex size-5 shrink-0 items-center justify-center rounded text-v2-text-text-faint hover:bg-v2-background-bg-layer-03 hover:text-v2-text-text-base focus-visible:outline focus-visible:outline-1 focus-visible:outline-v2-border-border-focus"
                  onClick={() => props.onRemove(attachment.id)}
                  aria-label={`${props.removeLabel}: ${attachment.filename}`}
                >
                  ✕
                </button>
              </div>
            )}
          </For>
          <For each={props.pending ?? []}>
            {(attachment) => (
              <div
                role="status"
                aria-live="polite"
                class="flex h-7 max-w-[220px] shrink-0 items-center gap-1.5 rounded-[var(--v2-radius-chip)] border border-v2-state-border-thinking bg-v2-state-bg-thinking px-2 text-[var(--v2-font-size-meta)] text-v2-state-fg-thinking"
              >
                <StatusGlyph name="running" size="small" />
                <span class="truncate">{props.uploadingLabel?.(attachment.filename) ?? attachment.filename}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </Show>
  )
}
