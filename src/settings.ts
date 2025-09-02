import { App, PluginSettingTab, Setting, Notice, TextComponent, ExtraButtonComponent } from 'obsidian';
import moment from 'moment';
import { GoogleCalendarTasksSyncSettings } from './types';
import GoogleCalendarTasksSyncPlugin from './main'; // main.ts からインポート

export const DEFAULT_SETTINGS: GoogleCalendarTasksSyncSettings = {
	clientId: '',
	clientSecret: '',
	tokens: null,
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
	showNotices: true, // 通知を表示するかどうか
	syncNoticeSettings: {
		showManualSyncProgress: true, // 手動同期の進捗表示
		showAutoSyncSummary: true, // 自動同期の要約のみ表示
		showErrors: true, // エラー通知を表示するか
		minSyncDurationForNotice: 10, // 通知を表示する最小同期時間（秒）
	},
	interBatchDelay: 500, // バッチリクエスト間のデフォルト遅延（ミリ秒）
};


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
		containerEl.createDiv('setting-item-description').append(
			'認証には、Google からの認証コードを受け取るための一時的なローカルウェブサーバー (HTTP ループバック) を使用します。',
			createEl('strong', { text: 'これが現在サポートされている唯一の方法です。' })
		);

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
						const portNum = parseInt(value, 10);
						const currentPortSetting = this.plugin.settings.loopbackPort;
						if (!isNaN(portNum) && portNum >= 1024 && portNum <= 65535) {
							if (currentPortSetting !== portNum) {
								this.plugin.settings.loopbackPort = portNum;
								await this.plugin.saveSettings(); // ここでは saveSettings を呼び出して再設定をトリガー
								this.display(); // 設定UIを再描画
								new Notice(`ポート設定が ${portNum} に変更されました。サーバーが再起動されます。`, 5000);
							}
						} else if (value !== currentPortSetting.toString()) {
							new Notice('無効なポート番号です (1024-65535)。', 5000);
							text.setValue(currentPortSetting.toString()); // 無効な値は元に戻す
						}
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
						const delay = parseInt(value, 10);
						let newDelay = current;
						if (isNaN(delay) || delay < 0) {
							newDelay = 0;
						} else if (delay > 5000) {
							newDelay = 5000;
						} else {
							newDelay = delay;
						}
						if (current !== newDelay) {
							this.plugin.settings.interBatchDelay = newDelay;
							await this.plugin.saveData(this.plugin.settings);
							text.setValue(newDelay.toString());
						} else if (value !== newDelay.toString()){
							text.setValue(newDelay.toString());
						}
					});
			});

		// 有効なリダイレクト URI (常に表示)
		const effectiveRedirectUri = this.plugin.getRedirectUri();
		new Setting(containerEl)
			.setName('リダイレクト URI (Google Console に必要)')
			.setDesc('この正確な URI を Google Cloud Console の「承認済みのリダイレクト URI」に追加してください。サーバーが異なるポートで自動起動した場合、Google Console の URI を更新する必要があります。')
			.addText(text => {
				text.inputEl.style.width = "100%";
				text.inputEl.readOnly = true;
				text.setValue(effectiveRedirectUri);
				text.setDisabled(true);

				const copyButton = new ExtraButtonComponent(text.inputEl.parentElement!)
					.setIcon('copy')
					.setTooltip('URI をコピー')
					.onClick(() => {
						navigator.clipboard.writeText(effectiveRedirectUri).then(
							() => new Notice('リダイレクト URI がコピーされました！', 2000),
							() => new Notice('コピーに失敗しました。', 3000)
						);
					});
				copyButton.extraSettingsEl.addClass('clickable-icon');
			 });

		// 認証ステータス表示
		const hasTokens = !!this.plugin.settings.tokens;
		const hasAccessToken = !!this.plugin.settings.tokens?.access_token;
		const isTokenCurrentlyValid = this.plugin.isTokenValid(false);
		const canRefreshToken = this.plugin.isTokenValid(true);

		let statusDesc = '未認証です。';
		let statusIcon = 'x-circle';
		let statusColor = 'var(--text-error)';

		if (hasTokens) {
			if (hasAccessToken && isTokenCurrentlyValid) {
				statusDesc = '認証済み。アクセストークンは有効です。';
				statusIcon = 'check-circle';
				statusColor = 'var(--text-success)';
			} else if (canRefreshToken) {
				statusDesc = '認証済みですが、アクセストークンが期限切れ/欠落しています。自動更新が有効です。';
				statusIcon = 'refresh-cw';
				statusColor = 'var(--text-warning)';
			} else {
				statusDesc = '認証が期限切れまたは不完全です (リフレッシュトークンなし)。再認証が必要です。';
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
							let minutes = parseInt(value, 10);
							const current = this.plugin.settings.syncIntervalMinutes;
							if (isNaN(minutes) || minutes < 1) {
								minutes = 1;
							}
							if (current !== minutes) {
								this.plugin.settings.syncIntervalMinutes = minutes;
								await this.plugin.saveSettings(); // タイマー再設定のため saveSettings
								text.setValue(minutes.toString()); // 画面表示を更新
							} else if (value !== minutes.toString()){
								// 入力が数値に変換しても変わらないが、文字列としては異なる場合 (例: "05" vs "5")
								text.setValue(minutes.toString()); // 表示を正規化
							}
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
							text.setValue(newDur.toString()); // 画面表示を更新
						} else if(value !== newDur.toString()){
							text.setValue(newDur.toString()); // 表示を正規化
						}
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

		// --- 通知設定セクション ---
		containerEl.createEl('h3', { text: '通知設定' });
		// 通知表示トグル
		new Setting(containerEl)
			.setName('処理完了通知を表示')
			.setDesc('バッチ処理完了などの通知を表示するかどうか')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showNotices)
				.onChange(async (value) => {
					this.plugin.settings.showNotices = value;
					await this.plugin.saveData(this.plugin.settings);
				}));

		// --- 同期通知設定セクション ---
		containerEl.createEl('h4', { text: '同期通知設定' });
		// 手動同期進捗表示
		new Setting(containerEl)
			.setName('手動同期の進捗を表示')
			.setDesc('手動同期時の進捗通知と「変更なし」通知を表示するかどうか')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncNoticeSettings.showManualSyncProgress)
				.onChange(async (value) => {
					this.plugin.settings.syncNoticeSettings.showManualSyncProgress = value;
					await this.plugin.saveData(this.plugin.settings);
				}));
		// 自動同期要約表示
		new Setting(containerEl)
			.setName('自動同期の要約を表示')
			.setDesc('自動同期完了時の要約通知を表示するかどうか')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncNoticeSettings.showAutoSyncSummary)
				.onChange(async (value) => {
					this.plugin.settings.syncNoticeSettings.showAutoSyncSummary = value;
					await this.plugin.saveData(this.plugin.settings);
				}));
		// エラー通知表示
		new Setting(containerEl)
			.setName('エラー通知を表示')
			.setDesc('同期エラー発生時の通知を表示するかどうか')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncNoticeSettings.showErrors)
				.onChange(async (value) => {
					this.plugin.settings.syncNoticeSettings.showErrors = value;
					await this.plugin.saveData(this.plugin.settings);
				}));

		// 通知表示最小時間
		new Setting(containerEl)
			.setName('通知表示最小時間 (秒)')
			.setDesc('同期時間がこの値以上の場合のみ通知を表示')
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
			});

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
			.setDesc('🚨【危険】リモートの全イベントを削除し、Obsidianのタスクを再登録します。リモートでの変更は全て失われます。')
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
	}
}
