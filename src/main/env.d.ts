/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CHATX_WS_URL?: string
  readonly VITE_CHATX_HTTP_URL?: string
  readonly VITE_CHATX_CHANNEL?: string
  readonly VITE_CHATX_CALLBACK_URL?: string
  readonly VITE_RENDER_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
