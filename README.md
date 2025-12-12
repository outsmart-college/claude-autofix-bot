# 🤖 Claude AutoFix Bot

> **Team-first AI coding assistant for Slack** — One bot, whole team collaborates

Unlike [Anthropic's Claude Code for Slack](https://code.claude.com/docs/en/slack) which requires every user to have their own Claude account, Claude AutoFix Bot is a **shared team resource**. Anyone on your team can report bugs, provide context, and follow up—all in the same thread, all contributing to the same fix.

## 🎯 Why This Exists

**The problem with per-user AI tools / Claude Code for Slack:**
- PM reports a bug → needs Claude Pro ($20/mo)
- Dev wants to add context → needs their own session
- Designer attaches a screenshot → can't contribute to the same thread
- Each person works in isolation

**Claude AutoFix Bot solves this:**
- One API key for the whole team
- PM reports bug → Dev replies with technical context → Designer adds screenshot
- Bot uses **ALL** that context to create one PR
- Anyone can follow up in the thread to iterate

## ⚡ Key Differentiators

| Feature | Claude AutoFix Bot | Anthropic's Claude Code for Slack |
|---------|-------------------|-----------------------------------|
| **Team collaboration** | Anyone can contribute to same thread | Sessions tied to individual accounts |
| **Pricing** | One API key (pay per use) | Every user needs Pro/Max/Team ($20-100+/mo per seat) |
| **Non-technical users** | Can trigger fixes, no account needed | Requires Claude account + Claude Code access |
| **Self-hosted** | Your infrastructure, your data | Runs on Anthropic's servers |
| **Auto-PR creation** | End-to-end in Slack | Manual "Create PR" button click |
| **Preview deployments** | Vercel integration built-in | Not available |

## ✨ Features

- 🎯 **Slack-Native**: Report issues directly in your team's Slack channel
- 👥 **Team Collaboration**: Multiple people contribute context in the same thread
- 🤖 **Claude Code CLI**: Full agentic capabilities (explore, edit, run tests)
- 📷 **Screenshot Support**: Attach images for visual context—Claude analyzes them
- 📝 **Auto-PR Creation**: Creates properly formatted PRs with semantic branch names
- 💬 **Rich Notifications**: Real-time Slack updates throughout the process
- 🔄 **Thread Follow-ups**: Reply in threads to continue working on the same branch
- 🔐 **Self-Hosted**: Your infrastructure, your data, your control

## 🎬 How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. PM posts in Slack: "The checkout button is broken on mobile" │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. Dev replies: "It's in CheckoutButton.tsx, z-index issue"     │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. Designer attaches screenshot of the bug                      │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. @bot analyzes ALL context and generates fix                  │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. Creates branch: fix/checkout-button-mobile                   │
│    Commits changes → Pushes to GitHub → Creates PR              │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. Bot posts PR link to Slack thread ✅                         │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│ 7. Anyone replies: "Also fix the hover state"                   │
│    → Bot updates same branch + PR with follow-up changes        │
└─────────────────────────────────────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites

- **Node.js 20+** installed
- **Slack workspace** with admin access
- **GitHub account** with repo access
- **Railway account** for deployment (or any Node.js host)
- **Anthropic API key** for Claude

### 1. Clone & Install

```bash
git clone https://github.com/MattKilmer/claude-autofix-bot.git
cd claude-autofix-bot
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env.local
```

Edit `.env.local` with your credentials (see [QUICKSTART.md](QUICKSTART.md) for detailed setup):

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Your Slack bot token |
| `SLACK_SIGNING_SECRET` | Slack signing secret |
| `SLACK_CHANNEL_ID` | Channel to monitor |
| `ANTHROPIC_API_KEY` | Your Claude API key |
| `GITHUB_TOKEN` | GitHub personal access token |
| `GITHUB_USERNAME` | Your GitHub username |
| `TARGET_REPO_URL` | Repository to fix |
| `BASE_BRANCH` | Main branch name (usually `main`) |

### 3. Run Locally

```bash
npm run dev
```

In another terminal, expose your local server:

```bash
npx ngrok http 3000
```

### 4. Configure Slack

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Create a new app
3. Enable **Event Subscriptions**
4. Set Request URL to: `https://your-ngrok-url.ngrok.io/api/slack-events`
5. Subscribe to bot events: `message.channels`
6. Install app to your workspace

### 5. Test It!

Post a message in your Slack channel:

```
Fix the bug in the navbar where the menu doesn't close on mobile
```

The bot will:
- ✅ React with 👀
- ✅ Analyze with Claude
- ✅ Create a new branch
- ✅ Commit the fix
- ✅ Create a PR
- ✅ Post results back to thread

## 📚 Documentation

- **[QUICKSTART.md](QUICKSTART.md)** — Step-by-step setup guide with API key instructions
- **[CLAUDE.md](CLAUDE.md)** — Technical context for developers and AI agents

## 🏗️ Project Structure

```
claude-autofix-bot/
├── src/
│   ├── server.ts           # Express server & Slack webhook handler
│   ├── config/             # Configuration management
│   ├── types/              # TypeScript type definitions
│   ├── services/           # Core services
│   │   ├── slack/          # Slack API integration
│   │   ├── claude/         # Claude Code CLI integration
│   │   ├── git/            # Git automation + GitHub API
│   │   └── deployment/     # Deployment tracking
│   ├── handlers/           # Business logic (issue-processor)
│   └── utils/              # Shared utilities
├── QUICKSTART.md           # Setup guide
└── CLAUDE.md               # Technical context
```

## 🛠️ Technology Stack

- **TypeScript** — Type-safe development
- **Node.js 20** — Runtime
- **Express** — HTTP server
- **Railway** — Hosting (persistent server for Claude CLI)
- **Claude Code CLI** — Full agentic AI capabilities
- **Slack API** — Team communication
- **GitHub API** — PR automation
- **simple-git** — Git operations
- **Zod** — Schema validation

## 🚀 Deployment (Railway)

1. Connect your GitHub repository to Railway
2. Set environment variables in Railway dashboard
3. Railway will auto-deploy on push to main
4. Update Slack Event Subscriptions URL:
   ```
   https://your-app.railway.app/api/slack-events
   ```

## 🔒 Security

- ✅ Slack signature verification on all webhooks
- ✅ Environment variables never committed
- ✅ GitHub tokens with minimal required scopes
- ✅ All operations logged for audit trail
- ✅ Rate limiting via job queue
- ✅ Self-hosted — your data stays on your infrastructure

## 🤝 Contributing

Contributions welcome! Please open an issue or submit a pull request.

## 📧 Support

- 🐛 [Report a Bug](https://github.com/MattKilmer/claude-autofix-bot/issues)
- 💡 [Request a Feature](https://github.com/MattKilmer/claude-autofix-bot/issues)
- 📖 [Read the Docs](QUICKSTART.md)

---

**Made by [Matt Kilmer](https://github.com/MattKilmer)**

*Team-first AI coding — because great software is built collaboratively.*
