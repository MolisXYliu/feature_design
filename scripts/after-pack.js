/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const fs = require("fs")
const path = require("path")

module.exports = async function(context) {
  try {
    // Only run on Linux. Allow override for local testing with FORCE_AFTER_PACK_LINUX=1
    const isLinux = process.platform === 'linux' || process.env.FORCE_AFTER_PACK_LINUX === '1'
    if (!isLinux) {
      console.log('after-pack: not running because platform is', process.platform, "(only runs on 'linux')")
      return
    }

    // context.appOutDir is the directory where Electron app is prepared (AppDir)
    const appOutDir = context && context.appOutDir ? context.appOutDir : process.env.APP_OUT_DIR
    if (!appOutDir) {
      console.log("after-pack: no appOutDir provided, skipping chrome-sandbox permission fix")
      return
    }
    console.log("after-pack: fixing chrome-sandbox permissions under", appOutDir)

    const candidates = []

    function walk(dir) {
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name)
        if (ent.isFile() && ent.name === "chrome-sandbox") {
          candidates.push(full)
        } else if (ent.isDirectory()) {
          if (ent.name === "node_modules" || ent.name === ".git") continue
          walk(full)
        }
      }
    }

    walk(appOutDir)

    if (candidates.length === 0) {
      console.log("after-pack: no chrome-sandbox binary found; nothing to change")
      return
    }

    for (const c of candidates) {
      try {
        fs.chmodSync(c, 0o4755)
        console.log("after-pack: chmod 4755 on", c)
      } catch (err) {
        console.warn("after-pack: failed to chmod", c, err && err.message)
      }
    }
  } catch (e) {
    console.warn("after-pack: unexpected error", e && e.stack)
  }
}
