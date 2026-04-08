/**
 * Local IP resolution — single source of truth for the main process.
 *
 * Iterates all network interfaces and returns the first non-internal IPv4
 * address. Used for both event reporting (operational telemetry) and
 * runtime IP exposure to the renderer.
 *
 * Falls back to "127.0.0.1" when no usable interface can be found.
 */

import { networkInterfaces } from "os"

export function getLocalIP(): string {
  let localIP = ""

  try {
    const interfaces = networkInterfaces()
    for (const name of Object.keys(interfaces)) {
      const list = interfaces[name]
      if (!list) continue
      for (const iface of list) {
        // Filter out IPv6, loopback (127.0.0.1), and internal addresses.
        if (iface.family === "IPv4" && !iface.internal) {
          localIP = iface.address
          // First non-internal IPv4 wins. Multi-NIC machines may need a
          // smarter strategy, but this matches the prior behaviour.
          break
        }
      }
      if (localIP) break
    }
  } catch {
    // fall through to default
  }

  return localIP || "127.0.0.1"
}
