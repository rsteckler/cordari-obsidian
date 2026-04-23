import { normalizePath, TFile, type App } from "obsidian";
import { CORDARI_SERVER_URL } from "./api.js";
import type { RecordingDetail } from "./types.js";

// Writes the per-recording markdown + audio into the vault and keeps them
// up to date on re-sync. Lookup by `cordari_id` in YAML frontmatter so
// renames (either side) never create duplicates — we rewrite the existing
// file in place, same cordari_id → same TFile.

/**
 * Bump this any time composeMarkdown's layout or wording changes. Files
 * whose frontmatter `cordari_writer_version` is below this value get
 * re-synced so stale content (old stubs, dropped fields, reshaped
 * sections) doesn't linger in the vault forever.
 *
 * History:
 *   v2 — multi-summary support; switched from `summaryMarkdown` to
 *        `summaries[]` rendering; new "_summary pending_" stub text
 *        replaced "_(no summary available)_".
 *   v3 — rebrand Applaud → Cordari. Frontmatter keys switched from
 *        `applaud_id` / `applaud_url` / `applaud_writer_version` to
 *        `cordari_*`. Notes written by pre-v3 plugin builds look
 *        "local-missing" to the sync layer (new keys absent) and get
 *        fully rewritten on the next pass.
 */
export const WRITER_VERSION = 3;

export interface WriterOpts {
  app: App;
  root: string;
}

export class VaultWriter {
  constructor(private readonly opts: WriterOpts) {}

  /**
   * Writes (or rewrites) the markdown file + audio for a single recording.
   * When `audioBytes` is null the caller is signalling "audio already
   * exists in the vault, or there's nothing to write" — we still handle
   * any rename of the existing .ogg to the current canonical name.
   */
  async writeRecording(detail: RecordingDetail, audioBytes: ArrayBuffer | null): Promise<TFile> {
    const { app, root } = this.opts;

    // Ensure folder exists.
    const folder = normalizePath(root);
    if (!app.vault.getAbstractFileByPath(folder)) {
      await app.vault.createFolder(folder);
    }

    const baseName = buildBaseName(detail);
    const audioRelName = `${baseName}.ogg`;
    const mdRelName = `${baseName}.md`;

    const existing = this.findExistingFile(detail.id);

    // If the recording was renamed upstream, rename the existing .ogg in
    // place before touching contents. The sync layer skips audio download
    // when the .ogg already exists, so this rename is how bytes follow
    // the new name without a redownload.
    const audioTargetPath = normalizePath(`${folder}/${audioRelName}`);
    const existingAudioForId = this.findExistingAudio(detail.id);
    if (
      existingAudioForId &&
      existingAudioForId.path !== audioTargetPath &&
      !app.vault.getAbstractFileByPath(audioTargetPath)
    ) {
      await app.fileManager.renameFile(existingAudioForId, audioTargetPath);
    }

    if (audioBytes) {
      const target = app.vault.getAbstractFileByPath(audioTargetPath);
      if (target instanceof TFile) {
        await app.vault.modifyBinary(target, audioBytes);
      } else {
        await app.vault.createBinary(audioTargetPath, audioBytes);
      }
    }

    const markdown = this.composeMarkdown(detail, audioRelName);
    const targetPath = normalizePath(`${folder}/${mdRelName}`);

    if (existing && existing.path !== targetPath) {
      await app.fileManager.renameFile(existing, targetPath);
    }

    const after = app.vault.getAbstractFileByPath(targetPath);
    if (after instanceof TFile) {
      await app.vault.modify(after, markdown);
      return after;
    }
    return await app.vault.create(targetPath, markdown);
  }

  /** Return the TFile whose frontmatter has `cordari_id === id`, if any. */
  private findExistingFile(id: string): TFile | null {
    const files = this.opts.app.vault.getMarkdownFiles();
    for (const f of files) {
      if (!f.path.startsWith(this.opts.root + "/")) continue;
      const cache = this.opts.app.metadataCache.getFileCache(f);
      const fm = cache?.frontmatter as Record<string, unknown> | undefined;
      if (fm?.cordari_id === id) return f;
    }
    return null;
  }

  /**
   * Match `.ogg` files to a recording id by the short-id suffix in the
   * filename (`..__{first8ofid}.ogg`). We don't get frontmatter on binary
   * files, so this is the best we can do without a sidecar index.
   */
  private findExistingAudio(id: string): TFile | null {
    const suffix = `__${id.slice(0, 8)}.ogg`;
    const root = this.opts.root;
    for (const f of this.opts.app.vault.getFiles()) {
      if (f.extension !== "ogg") continue;
      if (!f.path.startsWith(root + "/")) continue;
      if (f.path.endsWith(suffix)) return f;
    }
    return null;
  }

  private composeMarkdown(d: RecordingDetail, audioRelName: string): string {
    const state = d.status;
    const yaml = [
      "---",
      `cordari_id: ${d.id}`,
      `cordari_url: ${CORDARI_SERVER_URL}/recordings/${d.id}`,
      `cordari_writer_version: ${WRITER_VERSION}`,
      `date: ${new Date(d.startTime).toISOString()}`,
      `duration_ms: ${d.durationMs}`,
      `filename: ${yamlEscape(d.filename)}`,
      `state: ${state}`,
      "---",
      "",
    ].join("\n");

    const title = `# ${d.filename}`;
    const audioEmbed = d.audioDownloadedAt ? `![[${audioRelName}]]` : "_audio not yet downloaded_";

    const summarySection =
      d.summaries.length > 0
        ? d.summaries
            .map((s) => {
              const label = s.tabName ?? s.title ?? "Summary";
              return `## ${label}\n\n${(s.contentText ?? "").trim()}`;
            })
            .join("\n\n")
        : "## Summary\n\n_summary pending_";

    const transcriptSection =
      d.transcriptText && d.transcriptText.trim()
        ? `## Transcript\n\n${d.transcriptText.trim()}`
        : d.hasTranscript
          ? "## Transcript\n\n_(no transcript available)_"
          : "## Transcript\n\n_transcript pending_";

    return [yaml, title, "", audioEmbed, "", summarySection, "", transcriptSection, ""].join("\n");
  }
}

/**
 * Canonical filename stem for a recording. Exported so the sync layer can
 * predict the path and check whether the audio is already in the vault
 * before deciding to redownload.
 */
export function buildBaseName(
  d: Pick<RecordingDetail, "id" | "filename" | "startTime">,
): string {
  const dateStamp = new Date(d.startTime).toISOString().slice(0, 10);
  const safeFilename = sanitizeForFs(d.filename) || "recording";
  const shortId = d.id.slice(0, 8);
  return `${dateStamp}_${safeFilename}__${shortId}`;
}

/** Make a string safe for a filesystem path — mirrors the server's approach. */
function sanitizeForFs(name: string): string {
  return (
    name
      .replace(/[/\\:*?"<>|\r\n\t]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\s/g, "_")
      .replace(/_+/g, "_")
      .replace(/^[._]+|[._]+$/g, "")
      .slice(0, 100) || "recording"
  );
}

/** Single-line YAML string escape — wraps in double quotes if needed. */
function yamlEscape(s: string): string {
  if (/[:#[\]{}&*!|>'"%@`]|^[-?]|\s\s/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
  }
  return s;
}
