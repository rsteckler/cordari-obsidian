import { Notice, normalizePath, type App, type TFile } from "obsidian";
import { ApiError, type ApiClient } from "./api.js";
import type { RecordingRow } from "./types.js";
import { buildBaseName, VaultWriter, WRITER_VERSION } from "./writer.js";

export interface SyncOpts {
  app: App;
  client: ApiClient;
  serverBaseUrl: string;
  root: string;
  onUnauthorized: () => void;
}

interface LocalEntry {
  filename: string;
  mdPath: string;
  writerVersion: number;
}

/**
 * Scan the Applaud folder once per sync and return an applaud_id → local
 * state map from YAML frontmatter. Used to:
 *   - detect Plaud-side renames on complete recordings (re-fetch to
 *     update filename in frontmatter and rename the TFile),
 *   - detect missing local files on ids we've seen before (re-push to
 *     self-heal after a deleted/corrupt file),
 *   - avoid re-downloading the same audio when the .ogg is already next
 *     to the .md.
 */
function buildLocalIndex(app: App, root: string): Map<string, LocalEntry> {
  const cache = new Map<string, LocalEntry>();
  const prefix = root.endsWith("/") ? root : `${root}/`;
  for (const f of app.vault.getMarkdownFiles() as TFile[]) {
    if (!f.path.startsWith(prefix)) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter as
      | Record<string, unknown>
      | undefined;
    const id = typeof fm?.applaud_id === "string" ? fm.applaud_id : null;
    const filename = typeof fm?.filename === "string" ? fm.filename : null;
    // Missing / non-numeric version means the file was written by a
    // pre-versioning plugin build; treat as v0 so reasonToSync triggers
    // a rewrite on the next pass.
    const rawVersion = fm?.applaud_writer_version;
    const writerVersion = typeof rawVersion === "number" ? rawVersion : 0;
    if (id && filename) cache.set(id, { filename, mdPath: f.path, writerVersion });
  }
  return cache;
}

/**
 * Drive-style reconciliation pass. Always lists every recording, cheap-
 * skips the ones whose local state already matches, fetches detail +
 * audio only for the ones that need work. Writes are idempotent — same
 * content produces the same file on disk. No watermark optimization;
 * the server call + in-vault scan are both cheap, and this buys us
 * self-healing on vault-side file deletions or renames.
 *
 * Runs are not reentrant — callers should gate behind an in-memory flag.
 */
export async function runSync(opts: SyncOpts): Promise<void> {
  const writer = new VaultWriter({
    app: opts.app,
    root: opts.root,
    serverBaseUrl: opts.serverBaseUrl,
  });

  const localIndex = buildLocalIndex(opts.app, opts.root);
  console.info("[Applaud] sync start", { localKnown: localIndex.size });

  let offset = 0;
  let scanned = 0;
  let synced = 0;
  let skipped = 0;
  let audioReused = 0;
  const pageSize = 50;

  try {
    while (true) {
      const page = await opts.client.listRecordings({ limit: pageSize, offset });
      if (page.items.length === 0) break;
      scanned += page.items.length;

      for (const row of page.items) {
        const reason = reasonToSync(row, localIndex, opts.app);
        if (!reason) {
          skipped++;
          continue;
        }
        try {
          const r = await syncOne(row, opts.client, writer, opts.root, opts.app);
          synced++;
          if (r.audioReused) audioReused++;
          console.info("[Applaud] synced", {
            id: row.id,
            filename: row.filename,
            status: row.status,
            reason,
            wroteAudioBytes: r.wroteAudioBytes,
            audioReused: r.audioReused,
          });
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) throw err;
          console.warn("[Applaud] syncOne failed; continuing", {
            id: row.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (page.items.length < pageSize) break;
      offset += pageSize;
    }

    console.info("[Applaud] sync done", { scanned, synced, skipped, audioReused });
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      opts.onUnauthorized();
      return;
    }
    console.error("[Applaud] sync failed", err);
    new Notice(`Applaud sync failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Return a short string describing why this recording needs work, or null
 * if the local state is already correct. Checks in this order:
 *   1. Not complete on the server — pending transcript/summary may still
 *      arrive; re-fetch so the file stays current.
 *   2. No local .md with this applaud_id — either never synced or the
 *      user/sync error deleted it; re-push.
 *   3. Local md exists but at the wrong path for the current filename —
 *      Plaud (or the user) renamed the recording.
 */
function reasonToSync(
  row: RecordingRow,
  localIndex: Map<string, LocalEntry>,
  app: App,
): string | null {
  if (row.status !== "complete") return "status-pending";

  const local = localIndex.get(row.id);
  if (!local) return "local-missing";
  if (local.filename !== row.filename) return "filename-drift";

  // Writer bumps WRITER_VERSION whenever composeMarkdown's layout or
  // wording changes. Files written by older plugin builds get rewritten
  // so stale stubs / removed fields don't linger in the vault.
  if (local.writerVersion < WRITER_VERSION) return "writer-version-drift";

  // Defensive: the frontmatter says there's a local file, but the TFile is
  // actually gone from the adapter (rare — cache races, external sync
  // tools). Fall back to re-pushing.
  const path = normalizePath(local.mdPath);
  if (!app.vault.getAbstractFileByPath(path)) return "local-missing";

  return null;
}

async function syncOne(
  row: RecordingRow,
  client: ApiClient,
  writer: VaultWriter,
  root: string,
  app: App,
): Promise<{ wroteAudioBytes: number; audioReused: boolean }> {
  const detail = await client.recordingDetail(row.id);
  const r = detail.recording;

  // Skip the audio download when the target .ogg already exists in the
  // vault — cheap local check, saves tens of megabytes per reconciled
  // recording on big corpora. When Plaud renames, the target path
  // changes; the writer will rename the existing .ogg to the new name
  // on its own, so we only redownload when the file truly isn't there.
  const baseName = buildBaseName(r);
  const audioPath = normalizePath(`${root}/${baseName}.ogg`);
  const audioExists = !!app.vault.getAbstractFileByPath(audioPath);

  let audioBytes: ArrayBuffer | null = null;
  let audioReused = false;
  if (r.audioDownloadedAt && detail.audioUrl && !audioExists) {
    try {
      audioBytes = await client.downloadBinary(detail.audioUrl);
    } catch (err) {
      console.warn("[Applaud] audio download failed; continuing without it", err);
    }
  } else if (r.audioDownloadedAt && audioExists) {
    audioReused = true;
  }

  await writer.writeRecording(r, audioBytes);
  return { wroteAudioBytes: audioBytes?.byteLength ?? 0, audioReused };
}
