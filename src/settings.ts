import { App, PluginSettingTab, Setting, Notice, TextComponent, ExtraButtonComponent } from 'obsidian';
// セキュリティ診断は簡素化のため未使用
import moment from 'moment';
import { GoogleCalendarTasksSyncSettings } from './types';
import GoogleCalendarTasksSyncPlugin from './main'; // main.ts からインポート

// Vitest 等の非 Obsidian 実行環境では PluginSettingTab が undefined になるためのフォールバック
const PluginSettingTabBase: any = (PluginSettingTab as any) || class {
	app: App;
	plugin: any;
	containerEl: any;
	constructor(app: App, plugin: any) {
		this.app = app;
		this.plugin = plugin;
		this.containerEl = { empty: () => {}, createEl: () => ({}), createDiv: () => ({}) };
	}
	display(): void {}
};

export const DEFAULT_SETTINGS: GoogleCalendarTasksSyncSettings = {
	clientId: '',
	clientSecret: '',
	tokens: null, // メモリのみ。ディスクは tokensEncrypted を使用
	tokensEncrypted: null,
	encryptionPassphrase: null,
	rememberPassphrase: false,
	calendarId: 'primary',
	syncIntervalMinutes: 15,
	autoSync: true,
	taskMap: {},
	lastSyncTime: undefined,
	fetchWindowPastDays: 90,
	fetchWindowFutureDays: 180,
	includeDescriptionInIdentity: false,
	includeReminderInIdentity: false,
	useSyncToken: false,
	syncPriorityToDescription: true,
	syncTagsToDescription: true,
	syncBlockLinkToDescription: false, // デフォルトではオフ (Obsidian URI に統合されるため)
	syncScheduledDateToDescription: true,
	defaultEventDurationMinutes: 60,
	useLoopbackServer: true, // 常に true
	loopbackPort: 3000, // デフォルトポート
	requireRedirectUriRegistration: true,
	autoStopOnSuccess: false,
	showNotices: true, // 通知を表示するかどうか
	syncNoticeSettings: {
		showManualSyncProgress: true, // 手動同期の進捗表示
		showAutoSyncSummary: true, // 自動同期の要約のみ表示
		showErrors: true, // エラー通知を表示するか
		minSyncDurationForNotice: 10, // 通知を表示する最小同期時間（秒）
	},
	interBatchDelay: 500, // バッチリクエスト間のデフォルト遅延（ミリ秒）
	batchSize: 100, // 互換目的（旧設定）
	desiredBatchSize: 50,
	maxBatchPerHttp: 50, // Calendar は保守的に 50 を既定
	maxInFlightBatches: 2,
	latencySLAms: 1500,
	rateErrorCooldownMs: 1000,
	minDesiredBatchSize: 5,
	devLogging: false,
};



export class GoogleCalendarSyncSettingTab extends (PluginSettingTabBase as any) {
	plugin: GoogleCalendarTasksSyncPlugin; // 型をメインプラグインクラスに指定

// Vitest などで `obsidian` モジュールをモックする際、`PluginSettingTab` が
// undefined になるとクラス継承で TypeError が発生する。ランタイムでの
// import 時に例外が出ないよう、`PluginSettingTab` が存在しない場合は空の
// クラスを継承元として使用する。
// eslint-disable-next-line @typescript-eslint/ban-types
const SafePluginSettingTab: typeof PluginSettingTab = (PluginSettingTab ?? (class {} as any));


export class GoogleCalendarSyncSettingTab extends SafePluginSettingTab {
        plugin: GoogleCalendarTasksSyncPlugin; // 型をメインプラグインクラスに指定

        constructor(app: App, plugin: GoogleCalendarTasksSyncPlugin) { // 型をメインプラグインクラスに指定
                super(app, plugin);
                this.plugin = plugin;
        }

	display(): void {
		const { containerEl } = this;
		containerEl.empty(); // コンテナをクリア
		containerEl.createEl('h2', { text: 'Google Calendar Sync 設定' });

		// --- Google 認証セクション ---
		containerEl.createEl('h3', { text: 'Google 認証' });
		// クライアントID
		new Setting(containerEl)
			.setName('クライアント ID')
			.setDesc('Google OAuth クライアント ID。Google Cloud Console で取得します。')
			.addText(text => text
				.setPlaceholder('クライアント ID を入力')
				.setValue(this.plugin.settings.clientId)
				.onChange(async (value) => {
					this.plugin.settings.clientId = value.trim();
					await this.plugin.saveData(this.plugin.settings); // 直接 saveSettings ではなく saveData
					this.plugin.reconfigureOAuthClient(); // OAuthクライアントのみ再設定
				}));
		// クライアントシークレット
		new Setting(containerEl)
			.setName('クライアントシークレット')
			.setDesc('Google OAuth クライアントシークレット。Google Cloud Console で取得します。')
			.addText(text => {
				text.inputEl.type = 'password';
				text.setPlaceholder('クライアントシークレットを入力')
					.setValue(this.plugin.settings.clientSecret)
					.onChange(async (value) => {
						this.plugin.settings.clientSecret = value.trim();
						await this.plugin.saveData(this.plugin.settings); // 直接 saveSettings ではなく saveData
						this.plugin.reconfigureOAuthClient(); // OAuthクライアントのみ再設定
					});
			});

		// --- 認証リダイレクト (ローカルサーバー) セクション ---
		containerEl.createEl('h4', { text: '認証リダイレクト (ローカルサーバー)' });
		containerEl.createDiv({ cls: 'setting-item-description', text: '認証には、Google からの認証コードを受け取るためローカルウェブサーバーを使用します。' });

		// ポート設定 (常に表示)
		new Setting(containerEl)
			.setName('ローカルサーバーポート (初期試行)')
			.setDesc('プラグインがローカルサーバーに最初に試行するポート (1024-65535)。使用中の場合、後続のポートを自動的に試します。ポートが変更された場合は Google Console の URI を更新してください。')
			.addText((text: TextComponent) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1024';
				text.inputEl.max = '65535';
				text.setPlaceholder(DEFAULT_SETTINGS.loopbackPort.toString())
					.setValue(this.plugin.settings.loopbackPort.toString())
					.onChange(async (value) => {
						const currentPortSetting = this.plugin.settings.loopbackPort;
						const n = parseInt(value, 10);
						const portNum = isNaN(n) ? currentPortSetting : Math.max(1024, Math.min(65535, n));
						if (currentPortSetting !== portNum) {
							// 反映と再起動を確実化
							// @ts-ignore
							if (typeof (this.plugin as any).applyPortChange === 'function') {
								await (this.plugin as any).applyPortChange(portNum);
							} else {
								this.plugin.settings.loopbackPort = portNum;
								await this.plugin.saveSettings();
							}
							new Notice(`ポート設定が ${portNum} に変更されました。サーバーが再起動されます。`, 5000);
						}
						text.setValue(portNum.toString());
					});
			});
		// バッチ間遅延
		new Setting(containerEl)
			.setName('バッチ間遅延 (ミリ秒)')
			.setDesc('レート制限を回避するため、各バッチリクエスト間に設ける遅延時間 (0-5000ms)。')
			.addText((text: TextComponent) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.max = '5000';
				const current = this.plugin.settings.interBatchDelay;
				text.setValue(current.toString())
					.setPlaceholder(DEFAULT_SETTINGS.interBatchDelay.toString())
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						const newDelay = isNaN(n) ? current : Math.max(0, Math.min(5000, n));
						if (current !== newDelay) {
							this.plugin.settings.interBatchDelay = newDelay;
							await this.plugin.saveData(this.plugin.settings);
						}
						text.setValue(newDelay.toString());
					});
			});

		// 有効なリダイレクト URI (常に表示)
		const effectiveRedirectUri = this.plugin.getRedirectUri();
new Setting(containerEl)
			.setName('リダイレクト URI')
			.setDesc('Web アプリの場合はこの正確な URI を Google Cloud の承認済みリダイレクト URI に登録する。')
			.addText(text => {
				text.inputEl.style.width = "100%";
				text.inputEl.readOnly = true;
				text.setValue(effectiveRedirectUri);
				text.setDisabled(true);

				const copy = async () => {
					try {
						await navigator.clipboard.writeText(effectiveRedirectUri);
						new Notice('リダイレクト URI がコピーされました！', 2000);
					} catch {
						try {
							// eslint-disable-next-line @typescript-eslint/no-var-requires
							const { clipboard } = require('electron');
							clipboard.writeText(effectiveRedirectUri);
							new Notice('リダイレクト URI がコピーされました！', 2000);
						} catch {
							new Notice('コピーに失敗しました。', 3000);
						}
					}
				};
				const copyButton = new ExtraButtonComponent(text.inputEl.parentElement!)
					.setIcon('copy')
					.setTooltip('URI をコピー')
					.onClick(copy);
				copyButton.extraSettingsEl.addClass('clickable-icon');
			});

		// 認証ステータス表示
			const hasTokens = !!(this.plugin.settings.tokens || this.plugin.settings.tokensEncrypted);
			const hasAccessToken = !!this.plugin.oauth2Client?.credentials?.access_token;
			const isTokenCurrentlyValid = this.plugin.isTokenValid(false);
			const canRefreshToken = this.plugin.isTokenValid(true);

			let statusDesc = '未認証です。';
			let statusIcon = 'x-circle';
			let statusColor = 'var(--text-error)';

			if (hasTokens || canRefreshToken) {
				if (isTokenCurrentlyValid && hasAccessToken) {
					statusDesc = '認証済み（アクセストークン有効）';
					statusIcon = 'check-circle';
					statusColor = 'var(--text-success)';
				} else if (canRefreshToken) {
					statusDesc = '認証済み（必要時に自動更新）';
					statusIcon = 'check-circle';
					statusColor = 'var(--text-success)';
				} else {
					statusDesc = '認証が期限切れまたは不完全です（再認証が必要）';
					statusIcon = 'alert-circle';
					statusColor = 'var(--text-error)';
				}
			}
		// ステータス表示と認証/再認証ボタン
		new Setting(containerEl)
			.setName('認証ステータス')
				.setDesc(statusDesc)
				.addExtraButton(button => {
				button.setIcon(statusIcon)
					  .setTooltip(statusDesc);
				button.extraSettingsEl.style.color = statusColor;
			})
			.addButton(button => { // 認証/再認証ボタン
				button.setButtonText(hasTokens ? '再認証' : '認証')
					  .setTooltip(hasTokens ? 'Google で再承認する' : 'Google 認証を開始する')
					  .onClick(() => {
						  this.plugin.authenticate();
					  });
				// 未認証の場合のみ Call To Action スタイルを適用
				if (!hasTokens) {
					button.setClass('mod-cta');
				}
			});

		// --- 同期設定セクション ---
		containerEl.createEl('h3', { text: '同期設定' });
        // 同期対象の注意書き
        containerEl.createEl('p', {
            text: '開始日 (🛫 Start Date) と 期限日 (📅 Due Date) の両方を持つタスクのみが同期されます。',
            cls: 'setting-item-description'
        });
		// カレンダーID
		new Setting(containerEl)
			.setName('対象 Google Calendar ID')
			.setDesc('同期する Google Calendar の ID (デフォルトは "primary"、特定のカレンダー ID も指定可能)。')
			.addText(text => text
				.setPlaceholder('primary')
				.setValue(this.plugin.settings.calendarId)
				.onChange(async (value) => {
					this.plugin.settings.calendarId = value.trim() || 'primary';
					await this.plugin.saveSettings(); // ID変更時は再設定が必要
				}));
		// 自動同期トグル
		new Setting(containerEl)
			.setName('自動バックグラウンド同期')
			.setDesc('定期的にタスクを自動で同期します。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoSync)
				.onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings(); // タイマー再設定のため saveSettings
					this.display(); // 間隔設定の表示/非表示を切り替え
				}));
		// 同期間隔 (自動同期が有効な場合のみ表示)
		if (this.plugin.settings.autoSync) {
			new Setting(containerEl)
				.setName('同期間隔 (分)')
				.setDesc('同期を実行する頻度 (最小 1 分)。')
				.addText(text => {
					text.inputEl.type = 'number';
					text.inputEl.min = '1';
					text.setValue(this.plugin.settings.syncIntervalMinutes.toString())
						.setPlaceholder(DEFAULT_SETTINGS.syncIntervalMinutes.toString())
						.onChange(async (value) => {
							const current = this.plugin.settings.syncIntervalMinutes;
							const n = parseInt(value, 10);
							const minutes = isNaN(n) || n < 1 ? 1 : n;
							if (current !== minutes) {
								this.plugin.settings.syncIntervalMinutes = minutes;
								await this.plugin.saveSettings(); // タイマー再設定のため saveSettings
							}
							text.setValue(minutes.toString()); // 表示を正規化
						});
				});
		}

		// --- 同期挙動オプションセクション ---
		containerEl.createEl('h3', { text: '同期挙動オプション' });
		// イベントタイミングの説明
		new Setting(containerEl)
			.setName('イベントのタイミング')
			.setDesc('Google Calendar イベントは、Obsidian の開始日 (🛫) をイベント開始、期限日 (📅) をイベント終了として使用します。(両方の日付を持つタスクのみ同期)。時刻の有無による終日/時間指定イベントの扱いは README を参照してください。');
		// デフォルトイベント期間
		new Setting(containerEl)
			.setName('デフォルトイベント期間 (分)')
			.setDesc('開始日と期限日の両方に時刻があるが、期限時刻が開始時刻より前の場合に使用される期間 (最小 5 分)。')
			.addText((text: TextComponent) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '5';
				const current = this.plugin.settings.defaultEventDurationMinutes;
				text.setValue(current.toString())
					.setPlaceholder(DEFAULT_SETTINGS.defaultEventDurationMinutes.toString())
					.onChange(async (value) => {
						const dur = parseInt(value, 10);
						let newDur = current;
						if (isNaN(dur) || dur < 5) {
							newDur = 5; // 最小値にクランプ
						} else {
							newDur = dur;
						}
						if (current !== newDur) {
							this.plugin.settings.defaultEventDurationMinutes = newDur;
							await this.plugin.saveData(this.plugin.settings); // saveData で十分
						}
						text.setValue(newDur.toString()); // 画面表示を更新/正規化
					});
			});

		// 重複判定オプション
		containerEl.createEl('h4', { text: '重複判定オプション' });
		new Setting(containerEl)
			.setName('説明文を重複キーに含める')
			.setDesc('有効にすると、説明文の差異も重複判定に反映する。誤結合を避けたい場合に有効化。')
			.addToggle(toggle => toggle
				.setValue(!!this.plugin.settings.includeDescriptionInIdentity)
				.onChange(async (value) => {
					this.plugin.settings.includeDescriptionInIdentity = value;
					await this.plugin.saveData(this.plugin.settings);
				}));
		new Setting(containerEl)
			.setName('リマインダー有無を重複キーに含める')
			.setDesc('有効にすると、リマインダー（ポップアップ/メール）の有無も重複判定に反映する。')
			.addToggle(toggle => toggle
				.setValue(!!this.plugin.settings.includeReminderInIdentity)
				.onChange(async (value) => {
					this.plugin.settings.includeReminderInIdentity = value;
					await this.plugin.saveData(this.plugin.settings);
				}));

		// 取得窓（フル同期時）
		new Setting(containerEl)
			.setName('フル同期の取得窓（過去日数）')
			.setDesc('lastSyncTime が未設定のフル同期時に、過去N日分に取得を制限する (0 で無制限)。')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				const current = this.plugin.settings.fetchWindowPastDays ?? DEFAULT_SETTINGS.fetchWindowPastDays!;
				text.setValue(String(current))
					.onChange(async (value) => {
						let n = parseInt(value, 10);
						if (isNaN(n) || n < 0) n = 0;
						this.plugin.settings.fetchWindowPastDays = n;
						await this.plugin.saveData(this.plugin.settings);
						text.setValue(String(n));
					});
			});

		new Setting(containerEl)
			.setName('フル同期の取得窓（未来日数）')
			.setDesc('lastSyncTime が未設定のフル同期時に、未来M日分に取得を制限する (0 で無制限)。')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				const current = this.plugin.settings.fetchWindowFutureDays ?? DEFAULT_SETTINGS.fetchWindowFutureDays!;
				text.setValue(String(current))
					.onChange(async (value) => {
						let n = parseInt(value, 10);
						if (isNaN(n) || n < 0) n = 0;
						this.plugin.settings.fetchWindowFutureDays = n;
						await this.plugin.saveData(this.plugin.settings);
						text.setValue(String(n));
					});
			});
		// --- Google イベント説明欄の内容 ---
		containerEl.createEl('h4', { text: 'Google イベント説明欄の内容' });
		containerEl.createDiv({cls: 'setting-item-description', text: '同期されたタスクのイベント説明に含める詳細を選択します。'});
		// 優先度を追加
		new Setting(containerEl)
			.setName('優先度を追加')
			.setDesc('タスクの優先度 (例: "優先度: 🔼 中") を含めます。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncPriorityToDescription)
				.onChange(async (value) => {
					this.plugin.settings.syncPriorityToDescription = value;
					await this.plugin.saveData(this.plugin.settings); // saveData で十分
				}));
		// タグを追加
		new Setting(containerEl)
			.setName('タグを追加')
			.setDesc('Obsidian の #タグ を含めます。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncTagsToDescription)
				.onChange(async (value) => {
					this.plugin.settings.syncTagsToDescription = value;
					await this.plugin.saveData(this.plugin.settings); // saveData で十分
				}));
		// 予定日を追加
		new Setting(containerEl)
			.setName('予定日 (⏳) を追加')
			.setDesc('予定日を説明に含めます (同期タイミングには影響しません)。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncScheduledDateToDescription)
				.onChange(async (value) => {
					this.plugin.settings.syncScheduledDateToDescription = value;
					await this.plugin.saveData(this.plugin.settings); // saveData で十分
				}));

        // --- 通知設定 ---
        containerEl.createEl('h3', { text: '通知設定' });
        const refreshDisabled = () => this.display();

        // マスター: 通知を有効化
        new Setting(containerEl)
            .setName('通知を有効化')
            .setDesc('全ての通知のオン/オフを切り替える')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showNotices)
                .onChange(async (value) => {
                    this.plugin.settings.showNotices = value;
                    await this.plugin.saveData(this.plugin.settings);
                    refreshDisabled();
                }));

        const noticesEnabled = !!this.plugin.settings.showNotices;

        // 手動同期: 進捗/結果を表示
        new Setting(containerEl)
            .setName('手動同期の進捗/結果')
            .setDesc('手動実行時に進捗と結果を通知する')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncNoticeSettings.showManualSyncProgress)
                .onChange(async (value) => {
                    this.plugin.settings.syncNoticeSettings.showManualSyncProgress = value;
                    await this.plugin.saveData(this.plugin.settings);
                }))
            .setDisabled(!noticesEnabled);

        // 自動同期: 要約を表示（所要時間しきい値適用）
        new Setting(containerEl)
            .setName('自動同期の要約')
            .setDesc('自動実行が完了した時だけ要約を通知（所要時間しきい値適用）')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncNoticeSettings.showAutoSyncSummary)
                .onChange(async (value) => {
                    this.plugin.settings.syncNoticeSettings.showAutoSyncSummary = value;
                    await this.plugin.saveData(this.plugin.settings);
                }))
            .setDisabled(!noticesEnabled);

        // しきい値: 自動同期のみに適用
        new Setting(containerEl)
            .setName('要約表示の最小所要時間（秒）')
            .setDesc('自動同期の要約通知は、所要時間がこの秒数以上のときのみ表示')
            .addText(text => {
                text.inputEl.type = 'number';
                text.inputEl.min = '0';
                text.setValue(this.plugin.settings.syncNoticeSettings.minSyncDurationForNotice.toString())
                    .onChange(async (value) => {
                        const num = parseInt(value, 10);
                        if (!isNaN(num)) {
                            this.plugin.settings.syncNoticeSettings.minSyncDurationForNotice = num;
                            await this.plugin.saveData(this.plugin.settings);
                        }
                    });
            })
            .setDisabled(!noticesEnabled || !this.plugin.settings.syncNoticeSettings.showAutoSyncSummary);

        // エラー: 常に通知（マスターがONのとき）
        new Setting(containerEl)
            .setName('エラー通知')
            .setDesc('同期エラーが発生した場合に通知する')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncNoticeSettings.showErrors)
                .onChange(async (value) => {
                    this.plugin.settings.syncNoticeSettings.showErrors = value;
                    await this.plugin.saveData(this.plugin.settings);
                }))
            .setDisabled(!noticesEnabled);

		// --- 手動アクション & デバッグセクション ---
		containerEl.createEl('h3', { text: '手動アクション & デバッグ' });
		// 強制同期ボタン
		new Setting(containerEl)
			.setName('今すぐ強制同期')
			.setDesc('手動で同期サイクルを実行します。')
			.addButton(button => button
				.setButtonText('今すぐ同期')
				.setIcon('sync')
				.setTooltip('すぐに同期を実行する')
				.onClick(async () => {
					if (this.plugin.isCurrentlySyncing()) {
						new Notice("同期は既に進行中です。", 3000);
						return;
					}
					new Notice('手動同期をトリガーしました...', 2000);
					await this.plugin.triggerSync(); // main.ts の triggerSync を呼び出す
					this.display(); // 同期後のステータス（最終同期時刻など）を更新
				}));

		// 最終同期時刻の表示
		const lastSyncDesc = this.plugin.settings.lastSyncTime
			? `最終成功同期: ${moment(this.plugin.settings.lastSyncTime).calendar()} (${moment(this.plugin.settings.lastSyncTime).fromNow()})`
			: 'まだ正常に同期されていません。';
		containerEl.createEl('p', { text: lastSyncDesc, cls: 'setting-item-description' });

		// タスクマップキャッシュのクリアボタン
		new Setting(containerEl)
			.setName('タスクマップキャッシュをクリア')
			.setDesc('⚠️ タスクとイベント間の保存済みリンクをリセットします。次回の同期で重複イベントが発生する可能性があります。同期が壊れている場合に使用してください。')
			.addButton(button => button
				.setButtonText('タスクマップをクリア')
				.setIcon('trash-2')
				.setWarning()
				.onClick(async () => {
					if (confirm('本当にタスクマップキャッシュをクリアしますか？ この操作は元に戻せず、次回の同期で重複イベントが発生する可能性があります。')) {
						this.plugin.settings.taskMap = {};
						this.plugin.settings.lastSyncTime = undefined;
						await this.plugin.saveData(this.plugin.settings); // saveData を使う
						new Notice('タスクマップと最終同期時刻がクリアされました。');
						this.display(); // UI を再描画
					}
				}));

		// 強制リセットボタン
		new Setting(containerEl)
			.setName('Obsidianの状態を強制的にリモートへ反映')
			.setDesc('【危険】リモートの全イベントを削除し、Obsidianのタスクを再登録します。リモートでの変更は全て失われます。')
			.addButton(button => button
				.setButtonText('強制的にリモートをリセット')
				.setIcon('alert-triangle')
				.setWarning()
				.onClick(async () => {
					if (confirm('本当にリモートをリセットしますか？\nGoogleカレンダー上のこのプラグインが管理する全てのイベントが削除され、現在のObsidianのタスクが再登録されます。この操作は元に戻せません。')) {
						new Notice('強制リセットを開始します...', 3000);
						await this.plugin.forceSync();
						this.display();
					}
				}));

		// 現在のマップキャッシュのエントリ数を表示
		const taskCount = Object.keys(this.plugin.settings.taskMap).length;
		containerEl.createEl('p', {
			text: `キャッシュ内で ${taskCount} 件のタスクのリンクを追跡中。`,
			cls: 'setting-item-description'
		});

		// サブバッチ目標サイズ（desired）
		new Setting(containerEl)
			.setName('目標サブバッチサイズ')
			.setDesc('AIMD により自動調整。ここでの値は開始サイズ（5〜1000、既定50）。')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '5';
				text.inputEl.max = '1000';
				text.setValue(String(this.plugin.settings.desiredBatchSize ?? DEFAULT_SETTINGS.desiredBatchSize))
					.onChange(async (value) => {
						let n = parseInt(value, 10);
						if (isNaN(n) || n < 5) n = 5;
						if (n > 1000) n = 1000;
						this.plugin.settings.desiredBatchSize = n;
						await this.plugin.saveData(this.plugin.settings);
					});
			});

		// HTTP 1バッチ内のハード上限（max）
		new Setting(containerEl)
			.setName('HTTPバッチ上限/リクエスト')
			.setDesc('1つの HTTP バッチに含める最大件数（API固有の上限に合わせる。既定50）。')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.inputEl.max = '1000';
				text.setValue(String(this.plugin.settings.maxBatchPerHttp ?? DEFAULT_SETTINGS.maxBatchPerHttp))
					.onChange(async (value) => {
						let n = parseInt(value, 10);
						if (isNaN(n) || n < 1) n = 1;
						if (n > 1000) n = 1000;
						this.plugin.settings.maxBatchPerHttp = n;
						await this.plugin.saveData(this.plugin.settings);
					});
			});

		// 同時送信サブバッチ数
		new Setting(containerEl)
			.setName('同時送信バッチ数')
			.setDesc('同時に送るサブバッチ数（1〜4、既定2）。レートに触れたら自動で1に落とす。')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.inputEl.max = '4';
				text.setValue(String(this.plugin.settings.maxInFlightBatches ?? DEFAULT_SETTINGS.maxInFlightBatches))
					.onChange(async (value) => {
						let n = parseInt(value, 10);
						if (isNaN(n) || n < 1) n = 1;
						if (n > 4) n = 4;
						this.plugin.settings.maxInFlightBatches = n;
						await this.plugin.saveData(this.plugin.settings);
					});
			});

		// p95 レイテンシSLA
		new Setting(containerEl)
			.setName('p95 レイテンシSLA (ms)')
			.setDesc('サブバッチのp95レイテンシがこの値を超えるとサイズを半減（既定1500ms）。')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '200';
				text.inputEl.max = '10000';
				text.setValue(String(this.plugin.settings.latencySLAms ?? DEFAULT_SETTINGS.latencySLAms))
					.onChange(async (value) => {
						let n = parseInt(value, 10);
						if (isNaN(n) || n < 200) n = 200;
						if (n > 10000) n = 10000;
						this.plugin.settings.latencySLAms = n;
						await this.plugin.saveData(this.plugin.settings);
					});
			});

		// レート/一時障害後のクールダウン
		new Setting(containerEl)
			.setName('レート障害後クールダウン (ms)')
			.setDesc('429/403/5xx を検知した後に待つ時間（既定1000ms）。')
			.addText(text => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.max = '10000';
				text.setValue(String(this.plugin.settings.rateErrorCooldownMs ?? DEFAULT_SETTINGS.rateErrorCooldownMs))
					.onChange(async (value) => {
						let n = parseInt(value, 10);
						if (isNaN(n) || n < 0) n = 0;
						if (n > 10000) n = 10000;
						this.plugin.settings.rateErrorCooldownMs = n;
						await this.plugin.saveData(this.plugin.settings);
					});
			});

		// --- セキュリティ ---
		containerEl.createEl('h3', { text: 'セキュリティ' });
			const mode = (this.plugin as any).getEncryptionModeLabel ? (this.plugin as any).getEncryptionModeLabel() : '難読化 + 永続保存（既定）';
		new Setting(containerEl)
			.setName('保存方式')
			.setDesc(mode);

		// パスフレーズ（統合）
		new Setting(containerEl)
			.setName('AES-GCM パスフレーズ（任意）')
			.setDesc('設定すると refresh_token を AES-GCM で暗号化保存します。「パスフレーズを保存」OFF の場合はメモリのみで保持（再起動で消えます）。')
			.addText(text => {
				text.inputEl.type = 'password';
				text.setPlaceholder('未設定（任意）')
					.setValue(this.plugin.settings.rememberPassphrase ? (this.plugin.settings.encryptionPassphrase || '') : '')
					.onChange(async (value) => {
						if (this.plugin.settings.rememberPassphrase) {
							this.plugin.settings.encryptionPassphrase = value || null;
							await this.plugin.saveData(this.plugin.settings);
						} else {
							// @ts-ignore
							this.plugin.passphraseCache = value || null;
						}
					});
			});

		new Setting(containerEl)
			.setName('パスフレーズを保存（安全性低下）')
			.setDesc('ONにすると再起動後も入力不要（機密性は下がる）。')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.rememberPassphrase || false)
				.onChange(async (v) => {
					this.plugin.settings.rememberPassphrase = v;
					if (!v) this.plugin.settings.encryptionPassphrase = null;
					await this.plugin.saveData(this.plugin.settings);
				}));

		// --- デバッグ ---
		containerEl.createEl('h3', { text: 'デバッグ' });
		new Setting(containerEl)
			.setName('デベロッパーモード（詳細ログ）')
			.setDesc('コンソールに詳細ログを出力（既定OFF）。エラーは常に出力。')
			.addToggle(toggle => toggle
				.setValue(!!this.plugin.settings.devLogging)
				.onChange(async (v) => {
					this.plugin.settings.devLogging = v;
					await this.plugin.saveData(this.plugin.settings);
					try { const { setDevLogging } = await import('./logger'); setDevLogging(!!v); } catch {}
				}));
	}
}
