# 🚀 Quick Start Guide - Claude AutoFix Bot

## 📋 What You Need (API Keys & Credentials)

Before deploying, gather these credentials:

### 1. Slack (3 values)
- `SLACK_BOT_TOKEN` - Bot User OAuth Token
- `SLACK_SIGNING_SECRET` - Signing secret for webhook verification
- `SLACK_CHANNEL_ID` - Channel to monitor

### 2. Claude/Anthropic (1 value)
- `ANTHROPIC_API_KEY` - Your Claude API key

### 3. GitHub (2 values)
- `GITHUB_TOKEN` - Personal Access Token with `repo` scope
- `GITHUB_USERNAME` - Your GitHub username

### 4. Repository Configuration (2 values)
- `TARGET_REPO_URL` - URL of the repository to fix (e.g., https://github.com/your-org/your-repo.git)
- `BASE_BRANCH` - Usually `main` or `master`

---

## 🔧 Step-by-Step Setup

### Step 1: Set Up Slack App

#### A. Create Slack App

1. Go to https://api.slack.com/apps
2. Click **"Create New App"** → **"From scratch"**
3. Name it: `Claude AutoFix Bot`
4. Select your workspace

#### B. Configure Bot Token Scopes

1. Go to **OAuth & Permissions**
2. Scroll to **Bot Token Scopes**
3. Add these scopes:
   - `chat:write`
   - `chat:write.public`
   - `reactions:write`
   - `channels:history`
   - `channels:read`
   - `files:read` (for image/screenshot uploads)

4. Click **"Install to Workspace"**
5. **Copy the Bot User OAuth Token** (starts with `xoxb-`)

#### C. Get Signing Secret

1. Go to **Basic Information**
2. Scroll to **App Credentials**
3. **Copy the Signing Secret**

#### D. Get Channel ID

1. Open Slack (desktop or web)
2. Right-click on the channel you want to monitor
3. Select **"View channel details"**
4. Scroll down and copy the **Channel ID** (starts with `C`)

---

### Step 2: Set Up GitHub Token

1. Go to https://github.com/settings/tokens
2. Click **"Generate new token (classic)"**
3. Give it a name: `Claude AutoFix Bot`
4. Select scopes:
   - ✅ `repo` (all repo permissions)
   - ✅ `workflow`
5. Click **"Generate token"**
6. **Copy the token** (starts with `ghp_`)

---

### Step 3: Deploy to Railway

#### A. Create Railway Project

1. Go to https://railway.app
2. Click **"New Project"**
3. Select **"Deploy from GitHub repo"**
4. Connect your GitHub account and select the `claude-slackbot` repo

#### B. Configure Environment Variables

In Railway dashboard → Your Project → Variables, add:

```
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_CHANNEL_ID=C01234567

ANTHROPIC_API_KEY=sk-ant-your-key

GITHUB_TOKEN=ghp_your-token
GITHUB_USERNAME=your-username
TARGET_REPO_URL=https://github.com/your-org/your-repo.git
BASE_BRANCH=main

NODE_ENV=production
```

#### C. Get Your Railway URL

After deployment, Railway provides a URL like:
```
https://your-app.up.railway.app
```

---

### Step 4: Configure Slack Event Subscriptions

1. Go back to https://api.slack.com/apps
2. Select your app
3. Go to **Event Subscriptions**
4. Toggle **Enable Events** to **ON**
5. Set **Request URL** to:
   ```
   https://your-app.up.railway.app/api/slack-events
   ```
   (Use your actual Railway URL)

6. Wait for the green **"Verified ✓"** checkmark

7. Scroll to **Subscribe to bot events**
8. Click **"Add Bot User Event"**
9. Add: `message.channels`

10. Click **"Save Changes"**

---

### Step 5: Test It! 🎉

1. Go to your Slack channel
2. Post a message like:

```
Fix the typo in the README.md
```

3. Watch the magic happen:
   - Bot reacts with 👀
   - Posts status updates
   - Claude analyzes the code
   - Creates a new branch
   - Commits the fix
   - Creates a Pull Request
   - Posts final results with PR link! ✅

---

## 🎯 What Happens Behind the Scenes

```
1. Slack message received
   ↓
2. Signature verified ✓
   ↓
3. Job queued
   ↓
4. Bot reacts with 👀
   ↓
5. Repository cloned/pulled
   ↓
6. Claude analyzes codebase
   ↓
7. New branch created (e.g., "fix/typo-readme")
   ↓
8. Changes committed
   ↓
9. Branch pushed to GitHub
   ↓
10. Pull Request created
   ↓
11. Results posted to Slack ✅
```

---

## 📊 Expected Slack Updates

You'll see the message update through these stages:

1. `🔧 Analyzing issue...`
2. `📦 Cloning repository...`
3. `🤖 Running Claude Agent...`
4. `💾 Creating branch...`
5. `💾 Committing changes...`
6. `📤 Pushing to GitHub...`
7. `📝 Creating pull request...`
8. `✅ Fix Complete!` (with PR link)

---

## 🐛 Troubleshooting

### "Invalid Slack signature"
- Make sure `SLACK_SIGNING_SECRET` is correct
- Redeploy after changing environment variables

### "Claude API error"
- Verify `ANTHROPIC_API_KEY` is correct (starts with `sk-ant-`)
- Check you have API credits available

### "Git push failed"
- Verify `GITHUB_TOKEN` has `repo` scope
- Make sure token isn't expired
- Check repository permissions

### Webhook not receiving events
- Verify Slack Event Subscriptions URL is your Railway URL
- Check the "Verified ✓" checkmark in Slack app settings
- Look at Railway logs for errors

---

## 🎓 How to Use

### Simple Bug Fix
```
Fix the bug where the submit button doesn't work on the contact form
```

### Feature Request
```
Add a dark mode toggle to the settings page
```

### Documentation Update
```
Update the README to include installation instructions
```

### Refactoring
```
Refactor the authentication code to use async/await instead of promises
```

### With Screenshots
Attach a screenshot to your message for visual context:
```
Fix the button alignment issue (see attached screenshot)
```
→ Claude will analyze both your description AND the image to understand the issue!

### Thread Follow-ups (Continuing Work)
After the bot creates a PR, you can reply in the thread to continue working:
```
Also make the button blue
```
→ The bot will checkout the same branch and push changes to the same PR!

```
Add a loading spinner while submitting
```
→ More changes added to the existing PR

---

## 🎯 Success Checklist

- [ ] Slack app created with correct scopes
- [ ] GitHub token generated with `repo` scope
- [ ] Railway project deployed
- [ ] Environment variables set in Railway
- [ ] Slack Event Subscriptions URL configured
- [ ] Webhook verified ✓
- [ ] Test message triggers the bot
- [ ] Bot creates branch + PR successfully
- [ ] PR link posted back to Slack ✅
- [ ] Thread follow-up continues on same branch (optional)

---

## 🆘 Need Help?

Check Railway logs:
- Railway Dashboard → Your Project → Deployments → View Logs

Common issues are usually:
1. Missing or incorrect API keys
2. Slack webhook URL not updated
3. Repository permissions

---

## 🎉 You're Ready!

Your bot can now:
- Understand natural language bug reports
- Analyze screenshots and images for visual context
- Read and analyze entire codebases
- Generate fixes automatically
- Create proper git workflows
- Report back with actionable links
- Continue work via thread replies (same branch + PR)

Now go test it and watch Claude fix your code! 💪
