const BASE_URL = '/api'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UploadThreadsParams {
  /** Agent 任务的唯一标识，仅允许字母、数字、`-`、`_` */
  unique_id: string
  /** 埋点文件 */
  file: File
}

export interface UploadThreadsResponse {
  success: boolean
  message?: string
  [key: string]: unknown
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, init)

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`[${response.status}] ${response.statusText}: ${errorText}`)
  }

  return response.json() as Promise<T>
}

// ─── Threads API ──────────────────────────────────────────────────────────────

const threadsApi = {
  /**
   * 上传埋点数据文件
   * POST /threads/upload
   */
  upload(params: UploadThreadsParams): Promise<UploadThreadsResponse> {
    const formData = new FormData()
    formData.append('unique_id', params.unique_id)
    formData.append('file', params.file)

    return request<UploadThreadsResponse>(import.meta.env.VITE_API_BASE_URL+'/threads/upload', {
      method: 'POST',
      body: formData,
      // Content-Type is set automatically by the browser for multipart/form-data
    })
  },
}

export { threadsApi }

