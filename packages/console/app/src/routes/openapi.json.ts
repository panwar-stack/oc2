export async function GET() {
  const response = await fetch(
    "https://raw.githubusercontent.com/panwar-stack/oc2/refs/heads/dev/packages/sdk/openapi.json",
  )
  const json = await response.json()
  return json
}
