import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { OAuth2Client } from 'google-auth-library';

interface GoogleAuthSettings {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
}

export default class GoogleCalendarTasksSyncPlugin extends Plugin {
    settings: GoogleAuthSettings;
    oauth2Client: OAuth2Client;

    async onload() {
        await this.loadSettings();

        this.oauth2Client = new OAuth2Client({
            clientId: this.settings.clientId,
            clientSecret: this.settings.clientSecret,
            redirectUri: this.settings.redirectUri
        });

        this.addCommand({
            id: 'authenticate-with-google',
            name: 'Authenticate with Google',
            callback: async () => {
                const authUrl = this.oauth2Client.generateAuthUrl({
                    access_type: 'offline',
                    scope: [
                        'https://www.googleapis.com/auth/calendar',
                        'https://www.googleapis.com/auth/tasks'
                    ]
                });
                window.open(authUrl);
            }
        });

        // Register callback handler
        this.registerObsidianProtocolHandler('oauth2callback', async (params) => {
            const { code } = params;
            if (!code) return;

            try {
                const { tokens } = await this.oauth2Client.getToken(code);
                this.oauth2Client.setCredentials(tokens);
                await this.saveTokens(tokens);
                new Notice('Google authentication successful!');
            } catch (error) {
                console.error('OAuth error:', error);
                new Notice('Google authentication failed. Please try again.');
            }
        });

        this.addSettingTab(new GoogleAuthSettingTab(this.app, this));
    }

    async loadSettings() {
        this.settings = Object.assign({}, {
            clientId: '',
            clientSecret: '',
            redirectUri: 'http://localhost:8080/oauth2callback'
        }, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async saveTokens(tokens: any) {
        await this.saveData({ ...this.settings, tokens });
    }
}

class GoogleAuthSettingTab extends PluginSettingTab {
    plugin: GoogleCalendarTasksSyncPlugin;

    constructor(app: App, plugin: GoogleCalendarTasksSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    containerEl: HTMLElement;

    display(): void {
        const { containerEl } = this;

        containerEl.empty();
        containerEl.createEl('h2', { text: 'Google Calendar Tasks Sync Settings' });

        new Setting(containerEl)
            .setName('Client ID')
            .setDesc('Google OAuth Client ID')
            .addText(text => text
                .setPlaceholder('Enter your client ID')
                .setValue(this.plugin.settings.clientId)
                .onChange(async (value) => {
                    this.plugin.settings.clientId = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Client Secret')
            .setDesc('Google OAuth Client Secret')
            .addText(text => text
                .setPlaceholder('Enter your client secret')
                .setValue(this.plugin.settings.clientSecret)
                .onChange(async (value) => {
                    this.plugin.settings.clientSecret = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Redirect URI')
            .setDesc('OAuth Redirect URI')
            .addText(text => text
                .setPlaceholder('Enter redirect URI')
                .setValue(this.plugin.settings.redirectUri)
                .onChange(async (value) => {
                    this.plugin.settings.redirectUri = value;
                    await this.plugin.saveSettings();
                }));
    }
}
