import { BrowserWindow, Notification } from "electron"

const BODY_MAX = 200

/**
 * Show a desktop notification only when the app window is NOT focused.
 * This avoids disturbing the user when they are already looking at the app.
 */
export function notifyIfBackground(title: string, body: string): void {
  if (!Notification.isSupported()) return

  const win = BrowserWindow.getFocusedWindow()
  if (win && win.isFocused()) return

  let text = body
  if (text.length > BODY_MAX) {
    text = text.slice(0, BODY_MAX - 3) + "..."
  }
  new Notification({ title, body: text }).show()
}
