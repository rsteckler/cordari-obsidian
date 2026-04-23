import { Notice, Plugin } from "obsidian";
import { createClient } from "./api.js";
import { CordariSettingTab, DEFAULT_SETTINGS, type CordariSettings } from "./settings.js";
import { runSync } from "./sync.js";

export default class CordariPlugin extends Plugin {
  settings: CordariSettings = DEFAULT_SETTINGS;
  private syncing = false;
  private autoSyncHandle: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addSettingTab(new CordariSettingTab(this.app, this));

    this.addRibbonIcon("refresh-cw", "Sync Cordari recordings", () => {
      void this.syncNow();
    });

    this.addCommand({
      id: "cordari-sync-now",
      name: "Sync Cordari recordings",
      callback: () => void this.syncNow(),
    });

    // Sync on launch so users see fresh state when they open their vault.
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.token) void this.syncNow();
    });

    this.restartAutoSync();
  }

  onunload(): void {
    if (this.autoSyncHandle !== null) {
      window.clearInterval(this.autoSyncHandle);
      this.autoSyncHandle = null;
    }
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * (Re)install the auto-sync interval. Called on plugin load and whenever
   * `pollMinutes` changes from settings so the new cadence takes effect
   * without a vault reload.
   */
  restartAutoSync(): void {
    if (this.autoSyncHandle !== null) {
      window.clearInterval(this.autoSyncHandle);
      this.autoSyncHandle = null;
    }
    const intervalMs = Math.max(60_000, this.settings.pollMinutes * 60_000);
    this.autoSyncHandle = window.setInterval(() => {
      if (this.settings.token) void this.syncNow();
    }, intervalMs);
    this.registerInterval(this.autoSyncHandle);
  }

  /**
   * Run one sync pass. Re-entrancy is prevented via `this.syncing` —
   * overlapping timer ticks + manual Sync-now clicks while a long
   * backfill is running would otherwise hammer our API.
   */
  async syncNow(): Promise<void> {
    if (!this.settings.token) {
      new Notice("Cordari: not connected. Open Settings → Cordari → Connect.");
      return;
    }
    if (this.syncing) {
      new Notice("Cordari: sync already in progress.");
      return;
    }
    this.syncing = true;
    try {
      const client = createClient(this.settings.serverUrl, this.settings.token);
      await runSync({
        app: this.app,
        client,
        serverBaseUrl: this.settings.serverUrl,
        root: this.settings.root,
        onUnauthorized: () => {
          new Notice("Cordari: connection expired. Re-link from Settings → Cordari.");
          this.settings.token = null;
          this.settings.connectedName = null;
          void this.saveSettings();
        },
      });
    } finally {
      this.syncing = false;
    }
  }
}
