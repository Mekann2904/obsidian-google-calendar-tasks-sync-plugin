# Obsidian Google Calendar Tasks Sync Plugin

Sync your [Obsidian](https://obsidian.md/) tasks with [Google Calendar](https://calendar.google.com/).


## 🚀 Getting Started

### 1. Install the Plugin

This plugin is not yet on the official Obsidian Community Plugins store. To install manually:

1. Clone or download this repository.
2. Copy the contents to your `.obsidian/plugins/obsidian-google-calendar-tasks-sync-plugin` folder.
3. Enable the plugin in **Settings > Community Plugins**.

### 2. Authenticate with Google

1. In the plugin settings, click **"Authenticate with Google"**.
2. Sign in with your Google account and grant calendar access.
3. Choose which calendar to sync tasks to.

### 3. Write Tasks in Obsidian

Use the Tasks plugin syntax. Example:

```
- [ ] Do the thing 📅 2025-04-17 ⏰ 14:00
```

Tasks with due/start dates will be pushed to your Google Calendar.

## ⚙️ Settings

- **Sync Interval**: How often to sync (in minutes)
- **Target Calendar**: Select which calendar to sync to
- **Sync Direction**: Obsidian → Google, or Bi-directional (future)

## 🛠️ Development

This plugin is written in TypeScript and uses the Google Calendar API.

### Build

```bash
npm install
npm run build
```

## 📌 Roadmap

- [ ] Parse tasks and sync to Google Calendar
- [ ] Bi-directional sync (Google Calendar → Obsidian)
- [ ] Sync recurring tasks
- [ ] Integration with mobile devices
- [ ] Offline-safe queuing and retry

## 🧾 License

[MIT](LICENSE)

---

## 🇯🇵 日本語での使い方

### 1. プラグインのインストール

1. このリポジトリをクローンまたはダウンロードします
2. `.obsidian/plugins/obsidian-google-calendar-tasks-sync-plugin` フォルダに内容をコピーします
3. **設定 > コミュニティプラグイン** でプラグインを有効化します

### 2. Google認証

1. プラグイン設定で **「Googleで認証」** をクリック
2. Googleアカウントでサインインし、カレンダーへのアクセスを許可
3. 同期先のカレンダーを選択

### 3. Obsidianでタスクを書く

Tasksプラグインの構文を使用します。例:

```
- [ ] タスク内容 📅 2025-04-17 ⏰ 14:00
```

期日/開始日があるタスクがGoogleカレンダーに同期されます

### ⚙️ 設定項目の詳細

#### 認証設定
- **Client ID/Secret**: Google Cloud Consoleで取得したOAuth認証情報
- **Redirect URI**: `obsidian://oauth2callback` (デフォルト)

#### 同期設定
- **Target Calendar ID**: 同期先カレンダーID (`primary` がデフォルト)
- **Auto Sync**: 自動同期を有効/無効
- **Sync Interval**: 自動同期間隔(分) デフォルト15分

#### タスク同期動作
- **Use Start Date (🛫)**: 開始日をイベント開始日として使用
- **Use Scheduled Date (⏳)**: 予定日をイベント開始日として使用
- **Default Event Duration**: 時間指定なしタスクのデフォルト期間(分)

#### 説明文追加設定
- **Add Priority to Description**: 優先度を説明に追加
- **Add Tags to Description**: タグを説明に追加
- **Add Block Link to Description**: ブロックリンクを説明に追加

### ⚠️ 注意事項
- 初回同期には数分かかる場合があります
- モバイル版Obsidianでは認証フローが異なる場合があります
- 大量のタスクを一度に同期するとAPI制限に達する可能性があります

## 🧾 ライセンス

[MIT](LICENSE)

---
