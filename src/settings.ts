import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type ApplaudPlugin from "./main.js";
import { createClient } from "./api.js";

export interface ApplaudSettings {
  serverUrl: string;
  token: string | null;
  root: string;
  pollMinutes: number;
  lastSyncAt: number;
  connectedName: string | null;
}

export const DEFAULT_SETTINGS: ApplaudSettings = {
  serverUrl: "https://app.applaudnotes.com",
  token: null,
  root: "Applaud",
  pollMinutes: 5,
  lastSyncAt: 0,
  connectedName: null,
};

export class ApplaudSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: ApplaudPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Applaud" });

    const connected = !!this.plugin.settings.token;

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Only change this if you self-host Applaud.")
      .addText((text) =>
        text
          .setPlaceholder("https://app.applaudnotes.com")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value.trim() || "https://app.applaudnotes.com";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Vault folder")
      .setDesc("Recordings will be stored under this folder in your vault.")
      .addText((text) =>
        text
          .setPlaceholder("Applaud")
          .setValue(this.plugin.settings.root)
          .onChange(async (value) => {
            this.plugin.settings.root = value.trim() || "Applaud";
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Auto-sync interval (minutes)")
      .setDesc("How often to check for new recordings. Minimum 1.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.pollMinutes))
          .onChange(async (value) => {
            const n = Math.max(1, Math.floor(Number(value) || 5));
            this.plugin.settings.pollMinutes = n;
            await this.plugin.saveSettings();
            this.plugin.restartAutoSync();
          }),
      );

    new Setting(containerEl)
      .setName("Connection")
      .setDesc(
        connected
          ? `Connected${this.plugin.settings.connectedName ? ` as ${this.plugin.settings.connectedName}` : ""}.`
          : "Not connected.",
      )
      .addButton((btn) =>
        btn
          .setButtonText(connected ? "Re-link" : "Connect to Applaud")
          .setCta()
          .onClick(() => new DeviceLinkModal(this.app, this.plugin, () => this.display()).open()),
      );

    if (connected) {
      new Setting(containerEl)
        .setName("Disconnect")
        .setDesc("Clears the token locally. Revoke from app.applaudnotes.com Settings → Integrations to fully invalidate.")
        .addButton((btn) =>
          btn
            .setButtonText("Disconnect")
            .setWarning()
            .onClick(async () => {
              this.plugin.settings.token = null;
              this.plugin.settings.connectedName = null;
              await this.plugin.saveSettings();
              new Notice("Applaud: disconnected.");
              this.display();
            }),
        );
    }

    new Setting(containerEl)
      .setName("Sync now")
      .setDesc("Fetch any new recordings immediately.")
      .addButton((btn) =>
        btn
          .setButtonText("Sync now")
          .onClick(() => this.plugin.syncNow()),
      );
  }
}

/**
 * Modal that runs the device-code dance. Starts a grant, shows the
 * user_code + verification URL, and polls for approval on an interval
 * matching the server's suggested cadence.
 */
class DeviceLinkModal extends Modal {
  private userCode = "";
  private verificationUrl = "";
  private pollHandle: number | null = null;

  constructor(
    app: App,
    private readonly plugin: ApplaudPlugin,
    private readonly onDone: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Connect Applaud");
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: "Starting authorization…" });

    void this.start();
  }

  onClose(): void {
    if (this.pollHandle !== null) {
      window.clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.contentEl.empty();
  }

  private async start(): Promise<void> {
    const client = createClient(this.plugin.settings.serverUrl, null);
    try {
      const code = await client.startDeviceCode("Obsidian");
      this.userCode = code.user_code;
      this.verificationUrl = code.verification_uri_complete;
      this.renderPending();

      const intervalMs = Math.max(1000, code.interval * 1000);
      this.pollHandle = window.setInterval(() => {
        void this.poll(code.device_code);
      }, intervalMs);
    } catch (err) {
      this.renderError(err instanceof Error ? err.message : String(err));
    }
  }

  private renderPending(): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", {
      text: "Open the link below to authorize this vault. We'll pick up the approval automatically.",
    });
    const codeEl = this.contentEl.createEl("p");
    codeEl.style.textAlign = "center";
    codeEl.style.fontSize = "2em";
    codeEl.style.letterSpacing = "0.2em";
    codeEl.style.fontFamily = "monospace";
    codeEl.setText(this.userCode);

    const link = this.contentEl.createEl("a", {
      text: "Open authorization page",
      href: this.verificationUrl,
    });
    link.style.display = "block";
    link.style.textAlign = "center";
    link.style.marginTop = "1em";
    link.setAttr("target", "_blank");
    link.setAttr("rel", "noopener noreferrer");

    this.contentEl.createEl("p", {
      text: "Waiting for approval…",
      cls: "applaud-pending",
    }).style.textAlign = "center";
  }

  private async poll(deviceCode: string): Promise<void> {
    const client = createClient(this.plugin.settings.serverUrl, null);
    try {
      const r = await client.pollDeviceToken(deviceCode, "Obsidian");
      if (r.access_token) {
        this.plugin.settings.token = r.access_token;
        this.plugin.settings.connectedName = "Obsidian";
        this.plugin.settings.lastSyncAt = 0;
        await this.plugin.saveSettings();
        new Notice("Applaud: connected.");
        if (this.pollHandle !== null) {
          window.clearInterval(this.pollHandle);
          this.pollHandle = null;
        }
        this.close();
        this.onDone();
        void this.plugin.syncNow();
        return;
      }
      if (r.error === "expired_token") {
        this.renderError("Code expired. Try again.");
        if (this.pollHandle !== null) {
          window.clearInterval(this.pollHandle);
          this.pollHandle = null;
        }
      }
      // authorization_pending / server_error: keep waiting.
    } catch (err) {
      console.warn("[Applaud] device poll error", err);
    }
  }

  private renderError(message: string): void {
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: `Couldn't link: ${message}` });
  }
}
