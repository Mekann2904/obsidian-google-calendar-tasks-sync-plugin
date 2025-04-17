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
