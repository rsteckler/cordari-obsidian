// Shapes mirrored from the Cordari server. The plugin bundle is a single
// CommonJS file sent to users, so we can't depend on the server's shared
// package at build time — copy the subset we use.

export interface RecordingsListResponse {
  items: RecordingRow[];
  total: number;
  totalBytes: number;
}

export interface RecordingRow {
  id: string;
  userId: string;
  filename: string;
  /** epoch ms */
  startTime: number;
  /** epoch ms */
  endTime: number;
  durationMs: number;
  filesizeBytes: number;
  serialNumber: string;
  folder: string;
  audioPath: string | null;
  audioDownloadedAt: number | null;
  /** epoch ms — sort key for incremental polling. */
  ingestedAt: number;
  isHistorical: boolean;
  isTrash: boolean;
  lastError: string | null;
  hasTranscript: boolean;
  summaryCount: number;
  status:
    | "historical"
    | "pending_audio"
    | "pending_transcript"
    | "pending_summary"
    | "complete"
    | "error";
}

export interface Summary {
  id: string;
  source: "plaud" | "cordari";
  title: string | null;
  tabName: string | null;
  plaudTemplateId: string | null;
  contentText: string;
}

export interface RecordingDetailResponse {
  recording: RecordingDetail;
  mediaBase: string;
  audioUrl: string | null;
}

export interface RecordingDetail extends RecordingRow {
  transcriptText: string | null;
  summaries: Summary[];
}

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenPollResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: "authorization_pending" | "expired_token" | "invalid_request" | "server_error";
}
