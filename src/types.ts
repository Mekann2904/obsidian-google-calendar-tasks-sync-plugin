import { Credentials } from 'google-auth-library';
import { calendar_v3 } from 'googleapis';

// --- インターフェース定義 ---
export interface ObsidianTask {
	id: string; // Obsidian 内でのタスクの一意識別子 (例: ファイルパス + 行番号 + 内容ハッシュ)
	rawText: string; // Markdown ファイル内のタスクの元の行テキスト
	summary: string; // タスクの主内容 (日付やタグなどを除いたもの)
	isCompleted: boolean; // タスクが完了しているか
	dueDate: string | null; // 期限日 (YYYY-MM-DD or ISO 8601) (📅 or due:)
	startDate: string | null; // 開始日 (YYYY-MM-DD or ISO 8601) (🛫 or start:)
	scheduledDate: string | null; // 予定日 (YYYY-MM-DD or ISO 8601) (⏳ or scheduled:)
	createdDate: string | null; // 作成日 (YYYY-MM-DD) (➕ or created:)
	completionDate: string | null; // 完了日 (YYYY-MM-DD) (✅ or done:)
	priority: 'highest' | 'high' | 'medium' | 'low' | 'lowest' | null; // 優先度 (🔺⏫🔼🔽⏬)
	recurrenceRule: string | null; // 繰り返しルール (iCalendar RRULE 文字列) (🔁 or repeat:/recur:)
	// 🔁 拡張: 時間ウィンドウ (例: 15:00~24:00)
	timeWindowStart?: string | null; // 'HH:mm'
	timeWindowEnd?: string | null;   // 'HH:mm' または '24:00'
	tags: string[]; // タグ (例: #tag1)
	blockLink: string | null; // ブロックリンク (例: ^abcdef)
	sourcePath: string; // タスクが存在するファイルのパス
	sourceLine: number; // タスクが存在するファイルの行番号 (0-based)
}

// Google Calendar API のイベント入力型
export type GoogleCalendarEventInput = calendar_v3.Schema$Event & {
    reminders?: {
        useDefault: boolean;
        overrides?: Array<{ method: 'popup' | 'email'; minutes: number }>;
    };
};

export interface GoogleCalendarTasksSyncSettings {
	clientId: string; // Google Cloud Console で取得したクライアントID
	clientSecret: string; // Google Cloud Console で取得したクライアントシークレット
	tokens: Credentials | null; // Google から取得した認証トークン (アクセストークン、リフレッシュトークンなど)
	calendarId: string; // 同期対象の Google Calendar ID (通常 'primary' または特定のカレンダーID)
	syncIntervalMinutes: number; // 自動同期の間隔 (分単位)
	autoSync: boolean; // 自動同期を有効にするか
	taskMap: { [obsidianTaskId: string]: string }; // ObsidianタスクIDとGoogle CalendarイベントIDのマッピング
	lastSyncTime?: string; // 最後に同期が成功した時刻 (ISO 8601 形式)
	fetchWindowPastDays?: number; // フル同期時の取得窓: 過去日数
	fetchWindowFutureDays?: number; // フル同期時の取得窓: 未来日数
	includeDescriptionInIdentity?: boolean; // 重複判定に説明文を含めるか
	includeReminderInIdentity?: boolean;    // 重複判定にリマインダー有無を含めるか
	// Google Calendar イベントの説明欄にどの情報を含めるかの設定
	syncPriorityToDescription: boolean; // 優先度を説明に追加するか
	syncTagsToDescription: boolean; // タグを説明に追加するか
	syncBlockLinkToDescription: boolean; // ブロックリンクを説明に追加するか (注: 現在の実装では Obsidian URI に統合)
	syncScheduledDateToDescription: boolean; // 予定日 (Scheduled Date) を説明に追加するか
	defaultEventDurationMinutes: number; // 開始時刻と終了時刻が指定されているが、終了が開始より前の場合に使用するデフォルトのイベント時間 (分)
	useLoopbackServer: boolean; // 認証にローカルループバックサーバーを使用するか (現在はこの方法のみサポート)
	loopbackPort: number; // ローカルループバックサーバーが使用するポート番号
	showNotices: boolean; // 全通知のマスタースイッチ
	syncNoticeSettings: {
		showManualSyncProgress: boolean; // 手動同期の進捗表示
		showAutoSyncSummary: boolean; // 自動同期の要約のみ表示
		showErrors: boolean; // エラー通知を表示するか
		minSyncDurationForNotice: number; // 通知を表示する最小同期時間（秒）
	};
	interBatchDelay: number; // バッチリクエスト間の遅延（ミリ秒）
	batchSize?: number; // バッチ1回あたりの最大リクエスト数（最大1000、課金/レートはアイテム数で加算）
	recentErrors?: ErrorLog[]; // 最近のエラーサンプル（診断用）
	useSyncToken?: boolean; // 可能な場合、syncToken による増分取得を使用
}

// バッチリクエスト用のインターフェース
export interface BatchRequestItem {
	method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; // HTTPメソッド
	path: string; // APIのパス (例: /calendar/v3/calendars/{calendarId}/events/{eventId})
	headers?: { [key: string]: string }; // リクエストヘッダー (オプション)
	body?: any; // リクエストボディ (JSONなど)
	fullBody?: any; // PATCHのフォールバック用に保持する完全ボディ (オプション)
	obsidianTaskId?: string; // どのObsidianタスクに関連するか (結果処理で使用)
	operationType?: 'insert' | 'update' | 'patch' | 'delete'; // 実行した操作の種類 (結果処理で使用)
	originalGcalId?: string; // delete/update/patch 操作の対象となる元のGoogle CalendarイベントID
}

// バッチレスポンスのアイテムインターフェース
export interface BatchResponseItem {
	id?: string; // Google のレスポンスID (直接はあまり使わない)
	status: number; // 個別リクエストのHTTPステータスコード
	headers?: { [key: string]: string }; // 個別リクエストのレスポンスヘッダー (オプション)
	body?: any; // 個別リクエストのレスポンスボディ (通常はJSONオブジェクト or エラーメッセージ)
}

// バッチ処理全体の結果
export interface BatchResult {
    results: BatchResponseItem[];
    created: number;
    updated: number;
    deleted: number;
    errors: number;
    skipped: number;
    metrics?: SyncMetrics;
}

// エラーログ用インターフェース
export interface ErrorLog {
    errorType: 'permanent'|'transient';
    operation: 'delete'|'update'|'create';
    taskId: string;
    gcalId?: string;
    retryCount: number;
    errorDetails: any;
}

// 同期メトリクス
export interface SyncMetrics {
    sentSubBatches: number;      // 送信したサブバッチ数（最大1000件/バッチ。各パートは個別リクエストとしてカウント）
    attempts: number;            // 再送を含む試行回数
    totalWaitMs: number;         // バックオフ + インターバッチ待機の合計
    batchLatenciesMs: number[];  // 各サブバッチの往復レイテンシ
    statusCounts: { [status: number]: number }; // ステータスコード分布
}
