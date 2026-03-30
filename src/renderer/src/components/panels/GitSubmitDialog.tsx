import { CheckCircle2, Loader2, Upload } from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"

type GitSubmitAction = "commit" | "push"

interface GitSubmitDialogProps {
  open: boolean
  action: GitSubmitAction | null
  running: "commit" | "push" | null
  branch: string
  fileCount: number
  additions: number
  deletions: number
  requiresCommitMetadata: boolean
  cardNumber: string
  commitMessage: string
  onOpenChange: (open: boolean) => void
  onCardNumberChange: (value: string) => void
  onCommitMessageChange: (value: string) => void
  onSubmit: (action: GitSubmitAction) => void
}

export function GitSubmitDialog({
  open,
  action,
  running,
  branch,
  fileCount,
  additions,
  deletions,
  requiresCommitMetadata,
  cardNumber,
  commitMessage,
  onOpenChange,
  onCardNumberChange,
  onCommitMessageChange,
  onSubmit
}: GitSubmitDialogProps): React.JSX.Element {
  const formId = "git-submit-form"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md border-0 bg-transparent p-0 shadow-none">
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="text-2xl">Git 提交</CardTitle>
          </CardHeader>

          <CardContent>
            <form
              id={formId}
              onSubmit={(e) => {
                e.preventDefault()
              }}
            >
              <div className="flex flex-col gap-5">
                <div className="grid gap-2">
                  <div className="text-xs text-muted-foreground">分支</div>
                  <div className="text-sm font-medium break-all">{branch || "-"}</div>
                </div>

                <div className="grid gap-2">
                  <div className="text-xs text-muted-foreground">更改</div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span>{fileCount} 个文件</span>
                    <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span>
                    <span className="text-rose-600 dark:text-rose-400">-{deletions}</span>
                  </div>
                </div>

                {requiresCommitMetadata ? (
                  <>
                    <div className="grid gap-2">
                      <div className="text-sm font-medium">卡片编号</div>
                      <Input
                        id="git-card-number"
                        value={cardNumber}
                        onChange={(e) => onCardNumberChange(e.target.value)}
                        placeholder="输入卡片编号 cardNumber（必填）"
                        required
                      />
                    </div>

                    <div className="grid gap-2">
                      <div className="text-sm font-medium">提交消息</div>
                      <textarea
                        id="git-message"
                        value={commitMessage}
                        onChange={(e) => onCommitMessageChange(e.target.value)}
                        placeholder="请输入提交信息"
                        rows={4}
                        className="flex min-h-[96px] w-full rounded-sm border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 resize-y"
                      />
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-muted-foreground">
                    当前没有文件改动，将直接推送已有提交。
                  </div>
                )}

                <div className="text-sm font-medium">后续步骤</div>
              </div>
            </form>
          </CardContent>

          <CardFooter className="flex-col gap-2">
            {requiresCommitMetadata ? (
              <>
                <Button
                  type="button"
                  className="w-full"
                  variant={action === "push" ? "outline" : "default"}
                  disabled={running !== null}
                  onClick={() => onSubmit("commit")}
                >
                  {running === "commit" ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      提交中...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="size-4" />
                      提交 Commit
                    </>
                  )}
                </Button>

                <Button
                  type="button"
                  className="w-full"
                  variant={action === "push" ? "default" : "outline"}
                  disabled={running !== null}
                  onClick={() => onSubmit("push")}
                >
                  {running === "push" ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      推送中...
                    </>
                  ) : (
                    <>
                      <Upload className="size-4" />
                      提交并推送 Commit & Push
                    </>
                  )}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                className="w-full"
                disabled={running !== null}
                onClick={() => onSubmit("push")}
              >
                {running === "push" ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    推送中...
                  </>
                ) : (
                  <>
                    <Upload className="size-4" />
                    Push
                  </>
                )}
              </Button>
            )}

            <Button type="button" variant="ghost" className="w-full" onClick={() => onOpenChange(false)}>
              取消
            </Button>
          </CardFooter>
        </Card>
      </DialogContent>
    </Dialog>
  )
}
