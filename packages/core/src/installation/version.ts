declare global {
  const OC2_VERSION: string
  const OC2_CHANNEL: string
}

export const InstallationVersion = typeof OC2_VERSION === "string" ? OC2_VERSION : "local"
export const InstallationChannel = typeof OC2_CHANNEL === "string" ? OC2_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
