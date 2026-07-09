import { createEffect } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { dict as en } from "@/i18n/en"
import { dict as uiEn } from "@opencode-ai/ui/i18n/en"

export type Locale = "en"

const LOCALES = ["en"] as const
const dict: Record<string, string> = { ...en, ...uiEn }

function resolveTemplate(text: string, params?: Record<string, string | number | boolean>) {
  if (!params) return text
  return text.replace(/{{\s*([^}]+?)\s*}}/g, (_, rawKey) => {
    const key = String(rawKey)
    const value = params[key]
    return value === undefined ? "" : String(value)
  })
}

export function normalizeLocale(_value?: string): Locale {
  return "en"
}

export function loadLocaleDict(_locale?: Locale) {
  return Promise.resolve()
}

export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext({
  name: "Language",
  gate: false,
  init: () => {
    const locale = () => "en" as const
    const t = (key: string, params?: Record<string, string | number | boolean>) => {
      const value = dict[key] ?? String(key)
      return resolveTemplate(value, params)
    }

    createEffect(() => {
      if (typeof document !== "object") return
      document.documentElement.lang = "en"
      document.cookie = "oc_locale=en; Path=/; Max-Age=31536000; SameSite=Lax"
    })

    return {
      ready: () => true,
      locale,
      intl: locale,
      locales: LOCALES,
      label: (_locale?: Locale) => t("language.en"),
      t,
      setLocale: normalizeLocale,
    }
  },
})
