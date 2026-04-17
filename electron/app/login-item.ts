/**
 * Launch-at-login control via app.setLoginItemSettings / getLoginItemSettings.
 *
 * macOS 13+ uses SMAppService internally. Requires the app to be in /Applications/
 * for the setting to take effect (it will silently fail otherwise — Pitfall 9).
 */

import { app } from "electron";
import { warn } from "../../src/log/core.js";

/** Read the current launch-at-login state from the OS (not cached). */
export function getEnabled(): boolean {
  try {
    return app.getLoginItemSettings({ type: "mainAppService" }).openAtLogin;
  } catch {
    // May throw in dev mode or if not properly installed
    return false;
  }
}

/** Set or clear launch-at-login. */
export function setEnabled(enabled: boolean): void {
  // Warn if not in /Applications/ (setting will silently fail — Pitfall 9)
  const exePath = app.getPath("exe");
  if (!exePath.includes("/Applications/") && app.isPackaged) {
    warn(
      "[login-item] app is not in /Applications/ — launch-at-login may not work. " +
      "Drag the app to Applications first.",
    );
  }

  // Warn if not signed (unsigned SMAppService is flaky on macOS 13+)
  if (!app.isPackaged) {
    warn("[login-item] dev build: launch-at-login may not work for unsigned apps");
  }

  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      type: "mainAppService",
    });

    // Verify the setting was actually applied
    const actual = getEnabled();
    if (actual !== enabled) {
      warn(
        `[login-item] setLoginItemSettings(${String(enabled)}) requested but OS reports ${String(actual)}. ` +
        "User may need to approve in System Settings → General → Login Items.",
      );
    }
  } catch (err) {
    warn("[login-item] setLoginItemSettings failed:", err);
  }
}
