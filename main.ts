import {
  App,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  sanitizeHTMLToDom,
  Setting,
} from "obsidian";
import GitHubGateway, { parseRepo } from "src/github-gateway";
import { GetFrontMatterInfo } from "src/obsidian-implementations";
import Publisher from "src/publisher";

export interface OpenLakehousePluginSettings {
  /** Fine-grained (or classic) GitHub personal access token */
  githubToken: string;
  /** owner/name of the site repository receiving pull requests */
  targetRepo: string;
  baseBranch: string;
  /** owner/name of the repository holding the branch (e.g. your fork). Empty = auto */
  headRepo: string;
  defaultCategory: string;
  /** Comma separated author ids, e.g. "scott-haines, lisa-cao" */
  defaultAuthors: string;
  siteUrl: string;
}

export const DEFAULT_SETTINGS: OpenLakehousePluginSettings = {
  githubToken: "",
  targetRepo: "open-lakehouse/openlakehouse-io",
  baseBranch: "main",
  headRepo: "",
  defaultCategory: "",
  defaultAuthors: "",
  siteUrl: "https://openlakehouse.io",
};

export default class PublishToOpenLakehousePlugin extends Plugin {
  settings: OpenLakehousePluginSettings;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "publish-current-note",
      name: "Create/update OpenLakehouse post",
      checkCallback: (checking: boolean) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!(view && view.file)) {
          return false;
        }
        if (!checking) {
          const file = view.file;
          let publisher: Publisher<typeof file>;
          try {
            publisher = this.createPublisher();
          } catch (err) {
            new Notice(`Publish to OpenLakehouse: ${(err as Error).message}`, 0);
            return true;
          }
          const notice = new Notice("Publishing to OpenLakehouse…", 0);
          publisher.publish(file).then(
            (result) => {
              notice.hide();
              new Notice(
                `${result.pullRequestCreated ? "Opened" : "Updated"} pull request #${result.pullRequestNumber}\n${result.pullRequestUrl}`,
                10000,
              );
            },
            (err) => {
              notice.hide();
              console.error("Publish to OpenLakehouse failed", err);
              new Notice(
                `Publish to OpenLakehouse failed:\n${err instanceof Error ? err.message : String(err)}\n\nCheck your GitHub token and repository settings. See the console for details.`,
                0,
              );
            },
          );
        }
        return true;
      },
    });

    this.addSettingTab(new OpenLakehouseSettingTab(this.app, this));
  }

  createPublisher() {
    const s = this.settings;
    const targetRepo = parseRepo(s.targetRepo);
    if (!targetRepo) {
      throw new Error(`Invalid target repository "${s.targetRepo}", expected owner/name`);
    }
    const headRepo = s.headRepo.trim() ? parseRepo(s.headRepo) : undefined;
    if (s.headRepo.trim() && !headRepo) {
      throw new Error(`Invalid head repository "${s.headRepo}", expected owner/name`);
    }
    if (!s.githubToken) {
      throw new Error("Please configure a GitHub token in the plugin settings");
    }
    const gateway = new GitHubGateway(
      {
        token: s.githubToken,
        targetRepo,
        headRepo,
        baseBranch: s.baseBranch.trim() || "main",
      },
      requestUrl,
    );
    return new Publisher(this.app, gateway, new GetFrontMatterInfo(), {
      defaultCategory: s.defaultCategory.trim(),
      defaultAuthors: s.defaultAuthors
        .split(/[,\s]+/)
        .map((x) => x.trim())
        .filter(Boolean),
      siteUrl: s.siteUrl.trim() || DEFAULT_SETTINGS.siteUrl,
    });
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class OpenLakehouseSettingTab extends PluginSettingTab {
  plugin: PublishToOpenLakehousePlugin;

  constructor(app: App, plugin: PublishToOpenLakehousePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  private text(
    name: string,
    desc: string | DocumentFragment,
    key: keyof OpenLakehousePluginSettings,
    placeholder: string,
    password = false,
  ) {
    new Setting(this.containerEl)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        if (password) {
          text.inputEl.type = "password";
        }
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings[key])
          .onChange(async (value) => {
            this.plugin.settings[key] = value.trim();
            await this.plugin.saveSettings();
          });
      });
  }

  display(): void {
    this.containerEl.empty();

    this.text(
      "GitHub token",
      sanitizeHTMLToDom(
        "A GitHub personal access token with <i>Contents: read &amp; write</i> and <i>Pull requests: read &amp; write</i> on the repositories below.<br /><b>Security warning!</b><br />This will be stored unencrypted in your obsidian plugin folder. Do not use this plugin if you do not fully understand the security implications of this.",
      ),
      "githubToken",
      "github_pat_…",
      true,
    );
    this.text(
      "Target repository",
      "The site repository pull requests are opened against (owner/name).",
      "targetRepo",
      DEFAULT_SETTINGS.targetRepo,
    );
    this.text(
      "Base branch",
      "Branch of the target repository that post branches start from and pull requests merge into.",
      "baseBranch",
      DEFAULT_SETTINGS.baseBranch,
    );
    this.text(
      "Head repository",
      "Repository the obsidian/<slug> branches are pushed to (owner/name), e.g. your fork. Leave empty to push to the target repository when the token can, and otherwise to your fork (created if needed).",
      "headRepo",
      "your-user/openlakehouse-io",
    );
    this.text(
      "Default category",
      "Category folder used when a note has no ol-category, e.g. iceberg, delta-lake, apache-spark.",
      "defaultCategory",
      "iceberg",
    );
    this.text(
      "Default author id(s)",
      "Comma separated author ids (file names in src/content/authors) used when a note has no ol-authors.",
      "defaultAuthors",
      "scott-haines",
    );
    this.text(
      "Site URL",
      "Used to link to other published notes.",
      "siteUrl",
      DEFAULT_SETTINGS.siteUrl,
    );
  }
}
