import type { Message, HITLRequest } from "@/types"
import { DiffDisplay, ToolCallRenderer } from "./ToolCallRenderer";
import { StreamingMarkdown } from "./StreamingMarkdown"


interface ToolResultInfo {
  content: string | unknown
  is_error?: boolean
}

interface MessageBubbleProps {
  message: Message
  isStreaming?: boolean
  toolResults?: Map<string, ToolResultInfo>
  pendingApproval?: HITLRequest | null
  onApprovalDecision?: (decision: "approve" | "reject" | "edit") => void
}

export function MessageBubble({
  message,
  isStreaming,
  toolResults,
  pendingApproval,
  onApprovalDecision
}: MessageBubbleProps): React.JSX.Element | null {
  const isUser = message.role === "user"
  const isTool = message.role === "tool"

  // Hide tool result messages - they're shown inline with tool calls
  if (isTool) {
    return null
  }

  const renderContent = (): React.ReactNode => {
    if (typeof message.content === "string") {
      // Empty content
      if (!message.content.trim()) {
        return null
      }

      // Use streaming markdown for assistant messages, plain text for user messages
      if (isUser) {
        return <div className="whitespace-pre-wrap text-[15px] leading-7 text-foreground/95">{message.content}</div>
      }
      return <StreamingMarkdown isStreaming={isStreaming}>{message.content}</StreamingMarkdown>
    }

    // Handle content blocks
    const renderedBlocks = message.content
      .map((block, index) => {
        if (block.type === "text" && block.text) {
          // Use streaming markdown for assistant text blocks
          if (isUser) {
            return (
              <div key={index} className="whitespace-pre-wrap text-[15px] leading-7 text-foreground/95">
                {block.text}
              </div>
            )
          }
          return (
            <StreamingMarkdown key={index} isStreaming={isStreaming}>
              {block.text}
            </StreamingMarkdown>
          )
        }
        return null
      })
      .filter(Boolean)

    return renderedBlocks.length > 0 ? renderedBlocks : null
  }

  const content = renderContent()
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0

  // Don't render if there's no content and no tool calls
  if (!content && !hasToolCalls) {
    return null
  }

  if (isUser) {
    return (
      <div className="flex justify-end overflow-hidden">
        <div
          className="rounded-lg p-3 overflow-hidden bg-primary/10 max-w-[80%]"
        >
          {content}
        </div>
      </div>
    )
  }

  return (
    <div className="overflow-hidden space-y-1.5">
      <div className="flex items-center gap-2">
        <svg className="size-5 shrink-0" viewBox="0 0 120 120" fill="none">
          <defs>
            <linearGradient id="chat-lobster" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#ff4d4d"/>
              <stop offset="100%" stopColor="#991b1b"/>
            </linearGradient>
          </defs>
          <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill="url(#chat-lobster)"/>
          <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" fill="url(#chat-lobster)"/>
          <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" fill="url(#chat-lobster)"/>
          <path d="M45 15 Q35 5 30 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round"/>
          <path d="M75 15 Q85 5 90 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round"/>
          <circle cx="45" cy="35" r="6" fill="#050810"/>
          <circle cx="75" cy="35" r="6" fill="#050810"/>
          <circle cx="46" cy="34" r="2.5" fill="#00e5cc"/>
          <circle cx="76" cy="34" r="2.5" fill="#00e5cc"/>
        </svg>
        <span className="text-xs font-medium text-muted-foreground">Cmb Dev Claw</span>
      </div>

      <div className="flex-1 min-w-0 space-y-2 overflow-hidden pl-7">
        {content && <div className="rounded-lg p-3 overflow-hidden">{content}</div>}

        {hasToolCalls && (
          <div className="space-y-2 overflow-hidden">
            {message.tool_calls!.map((toolCall, index) => {
              const result = toolResults?.get(toolCall.id)
              const pendingId = pendingApproval?.tool_call?.id
              const needsApproval = Boolean(pendingId && pendingId === toolCall.id)
              return (
                <ToolCallRenderer
                  key={`${toolCall.id || `tc-${index}`}-${needsApproval ? "pending" : "done"}`}
                  toolCall={toolCall}
                  result={result?.content}
                  isError={result?.is_error}
                  needsApproval={needsApproval}
                  onApprovalDecision={needsApproval ? onApprovalDecision : undefined}
                />
              )
            })}


          </div>
        )}

        <DiffDisplay diff={`diff --git a/src/components/UserProfile.tsx b/src/components/UserProfile.tsx
index abc1234..def5678 100644
--- a/src/components/UserProfile.tsx
+++ b/src/components/UserProfile.tsx
@@ -1,10 +1,15 @@
 import React from 'react'
+import { useState } from 'react'
+import { Button } from '@/components/ui/button'

 interface UserProfileProps {
   name: string
-  email: string
+  email?: string
+  avatar?: string
 }

-export function UserProfile({ name, email }: UserProfileProps) {
+export function UserProfile({ name, email, avatar }: UserProfileProps) {
+  const [isFollowing, setIsFollowing] = useState(false)
+
   return (
     <div className="user-profile">
-      <h2>{name}</h2>
-      <p>{email}</p>
+      <div className="flex items-center gap-4">
+        <img src={avatar || '/default-avatar.png'} alt={name} className="w-12 h-12 rounded-full" />
+        <div>
+          <h2 className="text-xl font-semibold">{name}</h2>
+          {email && <p className="text-gray-600">{email}</p>}
+        </div>
+        <Button onClick={() => setIsFollowing(!isFollowing)} variant={isFollowing ? "outline" : "default"}>
+          {isFollowing ? 'Following' : 'Follow'}
+        </Button>
+      </div>
     </div>
   )
 }`}/>
      </div>
    </div>
  )
}
