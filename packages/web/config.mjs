const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://oc2.ai" : `https://${stage}.oc2.ai`,
  console: stage === "production" ? "https://oc2.ai/auth" : `https://${stage}.oc2.ai/auth`,
  email: "contact@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/panwar-stack/oc2",
  discord: "https://oc2.ai/discord",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
