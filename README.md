# Obsidian Google Calendar Tasks Sync Plugin

## 日本語

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
本プラグインは MIT ライセンスのもとで自由に使用できます。  
ただし、以下のような**公開の場で紹介・使用される場合**は、  
可能であれば次のいずれかへのリンクを表示していただけると嬉しいです：

- GitHub: [https://github.com/Mekann2904/obsidian-google-calendar-tasks-sync-plugin](https://github.com/Mekann2904/obsidian-google-calendar-tasks-sync-plugin)
- X (旧Twitter): [https://x.com/Mekann2904](https://x.com/Mekann2904)

---
# 謝辞
- Obsidian Tasksプラグインの開発者の方々に感謝します。   
  [https://github.com/obsidian-tasks-group/obsidian-tasks](https://github.com/obsidian-tasks-group/obsidian-tasks)

---
