import { defineMiddleware } from "astro:middleware"

function docsAlias(pathname: string) {
  const hit = /^\/docs\/([^/]+)(\/.*)?$/.exec(pathname)
  if (!hit) return null

  const value = hit[1] ?? ""
  const tail = hit[2] ?? ""
  const locale = value.trim().toLowerCase()
  if (locale !== "en" && locale !== "root") return null

  const next = `/docs${tail}`
  if (next === pathname) return null
  return next
}

function redirect(url: URL, path: string) {
  const next = new URL(url.toString())
  next.pathname = path
  return new Response(null, {
    status: 302,
    headers: {
      Location: next.toString(),
    },
  })
}

export const onRequest = defineMiddleware((ctx, next) => {
  const alias = docsAlias(ctx.url.pathname)
  if (!alias) return next()

  return redirect(ctx.url, alias)
})
