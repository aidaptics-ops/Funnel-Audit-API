import type { DeviceProfile, DeviceProfileName } from "../types/index.js";

const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

export const DEVICE_PROFILES: Record<DeviceProfileName, DeviceProfile> = {
  desktop: {
    name: "desktop",
    viewport: { width: 1440, height: 900 },
    userAgent: DESKTOP_UA,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  mobile: {
    name: "mobile",
    viewport: { width: 390, height: 844 },
    userAgent: MOBILE_UA,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
};

export function getDeviceProfile(name: DeviceProfileName = "desktop"): DeviceProfile {
  return DEVICE_PROFILES[name] ?? DEVICE_PROFILES.desktop;
}
