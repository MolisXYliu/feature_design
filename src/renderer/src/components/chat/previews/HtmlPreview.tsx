import { useCallback, useRef, useState } from "react"

interface HtmlPreviewProps {
  content: string
  path?: string
  fillHeight?: boolean
}

function getFileName(path: string): string {
  return path.split("/").pop() || path
}

export function HtmlPreview({ content, path, fillHeight = false }: HtmlPreviewProps): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [iframeHeight, setIframeHeight] = useState<number>(480)

  const syncHeight = useCallback(() => {
    const iframe = iframeRef.current
    if (!iframe) return

    try {
      const doc = iframe.contentDocument
      if (!doc) return
      const body = doc.body
      const html = doc.documentElement
      const nextHeight = Math.max(
        body?.scrollHeight || 0,
        body?.offsetHeight || 0,
        html?.scrollHeight || 0,
        html?.offsetHeight || 0
      )
      if (nextHeight > 0) {
        setIframeHeight(nextHeight)
      }
    } catch {
      // If cross-origin protection blocks access, keep default height.
    }
  }, [])

  return (
    <div className={`rounded-sm border border-border bg-background ${fillHeight ? "h-full flex flex-col" : ""}`}>
      <div className="px-2 py-1 text-[11px] text-muted-foreground border-b border-border bg-background-elevated truncate">
        HTML Preview{path ? ` · ${getFileName(path)}` : ""}
      </div>
      <iframe
        ref={iframeRef}
        title={path || "html-preview"}
        srcDoc={content}
        className={`w-full border-0 ${fillHeight ? "flex-1 min-h-0" : ""}`}
        style={fillHeight ? { height: "100%" } : { height: `max(${iframeHeight}px, 90vh)` }}
        sandbox="allow-same-origin"
        scrolling="no"
        onLoad={syncHeight}
      />
    </div>
  )
}

export default HtmlPreview
