# 🤖 Claude AutoFix Bot

> Automated code fixing via Slack → Claude → Git PR

Transform your Slack channel into an AI-powered development assistant. Report a bug or request a feature, and Claude will analyze your codebase, generate a fix, create a pull request, and report back—all automatically.

## ✨ Features

- 🎯 **Slack-Native**: Report issues directly in your team's Slack channel
- 🤖 **Claude Code CLI**: Uses Claude Code CLI for full agentic capabilities (explore, edit, run tests)
- 📷 **Screenshot Support**: Attach images for visual context - Claude analyzes them too
- 📝 **Auto-PR Creation**: Creates properly formatted pull requests with semantic branch names
- 💬 **Rich Notifications**: Real-time Slack updates throughout the process
- 🔄 **Thread Follow-ups**: Reply in threads to continue working on the same branch/PR
- 🔄 **Full Audit Trail**: Every change is tracked via Git history

## 🎬 How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. User posts in Slack: "Fix the navigation bar mobile bug"    │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│ 2. Bot acknowledges with 👀 reaction                            │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│ 3. Claude analyzes codebase and generates fix                  │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│ 4. Creates new branch: fix/navigation-bar-mobile                │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│ 5. Commits changes and pushes to GitHub                        │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│ 6. Creates Pull Request with detailed description              │
└────────────────────────┬────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────────┐
│ 7. Bot posts PR link to Slack thread ✅                         │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ 8. (Optional) Reply in thread to continue working               │
│    → Bot updates same branch + PR with follow-up changes        │
└─────────────────────────────────────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites

- **Node.js 20+** installed
- **Slack workspace** with admin access
- **GitHub account** with repo access
- **Railway account** for deployment
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

Edit `.env.local` and add your credentials (see [QUICKSTART.md](QUICKSTART.md) for detailed setup guide):

- `SLACK_BOT_TOKEN` - Your Slack bot token
- `SLACK_SIGNING_SECRET` - Slack signing secret
- `SLACK_CHANNEL_ID` - Channel to monitor
- `ANTHROPIC_API_KEY` - Your Claude API key
- `GITHUB_TOKEN` - GitHub personal access token
- `GITHUB_USERNAME` - Your GitHub username
- `TARGET_REPO_URL` - Repository to fix (e.g., https://github.com/your-org/your-repo.git)
- `BASE_BRANCH` - Main branch name (usually `main`)

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

- **[QUICKSTART.md](QUICKSTART.md)** - Step-by-step setup guide with API key instructions
- **[CLAUDE.md](CLAUDE.md)** - Comprehensive technical context for developers and AI agents

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
│   └── utils/              # Shared utilities (logger, queue, thread-tracking)
├── QUICKSTART.md           # Setup guide
└── CLAUDE.md               # Technical context
```

## 🛠️ Technology Stack

- **TypeScript** - Type-safe development
- **Node.js 20** - Runtime
- **Express** - HTTP server
- **Railway** - Hosting (requires persistent server for Claude CLI)
- **Claude Code CLI** - Full agentic AI capabilities (read, edit, bash, glob, grep)
- **Slack API** - Team communication
- **GitHub API** - PR automation
- **simple-git** - Git operations
- **Zod** - Schema validation

## 🧪 Development

```bash
# Type checking
npm run type-check

# Linting
npm run lint

# Run tests
npm test

# Build for production
npm run build
```

## 🚀 Deployment (Railway)

1. Connect your GitHub repository to Railway
2. Set environment variables in Railway dashboard
3. Railway will auto-deploy on push to main
4. Update Slack Event Subscriptions URL to your Railway URL:
   ```
   https://your-app.railway.app/api/slack-events
   ```

## 🔒 Security

- ✅ Slack signature verification on all webhooks
- ✅ Environment variables never committed
- ✅ GitHub tokens with minimal required scopes
- ✅ All operations logged for audit trail
- ✅ Rate limiting via job queue

## 🤝 Contributing

Contributions are welcome! Please open an issue or submit a pull request on GitHub.

## 🙏 Acknowledgments

- Built with [Claude](https://anthropic.com) by Anthropic
- Deployed on [Railway](https://railway.app)

## 📧 Support

- 🐛 [Report a Bug](https://github.com/MattKilmer/claude-autofix-bot/issues)
- 💡 [Request a Feature](https://github.com/MattKilmer/claude-autofix-bot/issues)
- 📖 [Read the Docs](QUICKSTART.md)

---

**Made by [Matt Kilmer](https://github.com/MattKilmer)**

*Transforming how teams ship code, one Slack message at a time.*
