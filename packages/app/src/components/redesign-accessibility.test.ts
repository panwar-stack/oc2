import { describe, expect, test } from "bun:test"

const app = (path: string) => Bun.file(`${import.meta.dir}/${path}`).text()
const ui = (path: string) => Bun.file(`${import.meta.dir}/../../../ui/src/${path}`).text()

describe("redesign accessibility contracts", () => {
  test("names settings, palette, and provider dialogs independently of visible actions", async () => {
    const [settings, palette, custom, connect, legacyDialog, dialogV2] = await Promise.all([
      app("settings-v2/dialog-settings-v2.tsx"),
      app("dialog-select-file.tsx"),
      app("dialog-custom-provider.tsx"),
      app("dialog-connect-provider.tsx"),
      ui("components/dialog.tsx"),
      ui("v2/components/dialog-v2.tsx"),
    ])

    expect(legacyDialog).toContain("aria-label={props.accessibleTitle}")
    expect(dialogV2).toContain("aria-label={local.accessibleTitle}")
    expect(settings).toContain('accessibleTitle={language.t("command.category.settings")}')
    expect(palette).toContain('language.t("session.header.searchFiles")')
    expect(palette).toContain('language.t("palette.search.placeholder")')
    expect(custom).toContain('accessibleTitle={language.t("provider.custom.title")}')
    expect(connect).toContain('language.t("provider.connect.title", { provider: provider().name })')
  })

  test("associates settings labels and server field labels with their controls", async () => {
    const [general, select, server, models, servers, shortcuts] = await Promise.all([
      app("settings-v2/general.tsx"),
      ui("v2/components/select-v2.tsx"),
      app("settings-v2/dialog-server-v2.tsx"),
      app("settings-v2/models.tsx"),
      app("settings-v2/servers.tsx"),
      app("settings-keybinds.tsx"),
    ])

    for (const key of [
      "settings.general.row.shell.title",
      "settings.general.row.colorScheme.title",
      "settings.general.row.theme.title",
      "settings.general.sounds.agent.title",
      "settings.general.sounds.permissions.title",
      "settings.general.sounds.errors.title",
    ]) {
      expect(general, key).toContain(`aria-label={language.t("${key}")}`)
    }
    expect(select).toContain('aria-label={local["aria-label"]}')
    for (const field of ["url", "name", "username", "password"]) {
      expect(server).toContain(`for="settings-server-${field}"`)
      expect(server).toContain(`id="settings-server-${field}"`)
    }
    for (const source of [models, servers, shortcuts]) {
      expect(source).toContain('aria-label={`${language.t("common.clear")}:')
      const clear = source.slice(source.indexOf("<IconButtonV2", source.indexOf("settings-v2-tab-search-clear") - 200))
      expect(clear.slice(0, clear.indexOf("/>"))).not.toContain('size="small"')
    }
  })

  test("keeps decision and attachment removal actions at least 24px", async () => {
    const [message, images, context] = await Promise.all([
      ui("components/message-part.css"),
      app("prompt-input/image-attachments.tsx"),
      app("prompt-input/context-items.tsx"),
    ])
    const progress = message.slice(message.indexOf('[data-slot="question-progress-segment"]'))

    expect(progress).toContain("width: 24px")
    expect(progress).toContain("height: 24px")
    expect(progress).toContain("width: 16px")
    expect(images.match(/size-6/g)?.length).toBeGreaterThanOrEqual(2)
    expect(images).toContain("group-focus-within:opacity-100 focus:opacity-100")
    expect(context).toContain('class="ml-auto size-6')
  })
})
