# Claude CLI Integration Architecture

> **Status:** ✅ Implemented (December 2025)

## Overview

This document describes the architecture for integrating Claude Code CLI. This approach gives us full Claude Code capabilities including MCP servers, native skills, and the ability to run tests/lint/build commands.

## Why Claude CLI over Agent SDK?

| Feature | Agent SDK | Claude CLI |
|---------|-----------|------------|
| MCP Servers | ❌ No | ✅ Yes |
| Native Skills | ❌ No | ✅ Yes |
| Run tests/lint/build | ❌ No | ✅ Yes |
| Full tool access | Limited | ✅ All tools |
| Conversation resume | ❌ No | ✅ `--resume` |
| Streaming output | Via callbacks | ✅ `--output-format stream-json` |
| Cost tracking | Manual | ✅ Built-in |

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        SLACK WORKSPACE                          │
│  ┌─────────────┐                          ┌─────────────────┐  │
│  │ User posts  │                          │ Bot posts       │  │
│  │ bug report  │                          │ status updates  │  │
│  └──────┬──────┘                          └────────▲────────┘  │
└─────────┼──────────────────────────────────────────┼───────────┘
          │                                          │
          ▼                                          │
┌─────────────────────────────────────────────────────────────────┐
│                    VERCEL SERVERLESS                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ /api/slack-events                                        │   │
│  │ - Verify Slack signature                                 │   │
│  │ - Acknowledge immediately (200 OK)                       │   │
│  │ - Queue job to Redis/VM                                  │   │
│  └──────────────────────────┬──────────────────────────────┘   │
└─────────────────────────────┼──────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      JOB QUEUE (Redis)                          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Queue: claude-jobs                                       │   │
│  │ - Job ID, Slack thread, message text, repo info          │   │
│  │ - Status: pending → processing → completed/failed        │   │
│  └──────────────────────────┬──────────────────────────────┘   │
└─────────────────────────────┼──────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    VM / CONTAINER (Railway/Render)              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Job Worker Process                                       │   │
│  │ 1. Poll Redis for jobs                                   │   │
│  │ 2. Clone/pull target repo                                │   │
│  │ 3. Run: claude -p "$message" --output-format stream-json │   │
│  │ 4. Stream updates to Slack in real-time                  │   │
│  │ 5. Commit, push, create PR                               │   │
│  │ 6. Report results to Slack                               │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  Prerequisites on VM:                                           │
│  - Node.js 20+                                                  │
│  - Claude CLI (`npm install -g @anthropic-ai/claude-code`)      │
│  - Git with credentials                                         │
│  - Target repo's dependencies (optional, for tests/build)       │
└─────────────────────────────────────────────────────────────────┘
```

## Current Implementation

We use **Railway** as our hosting platform with Claude CLI shell-out. This gives us:

- ✅ Full Claude Code CLI capabilities
- ✅ No timeout limits (Railway persistent server)
- ✅ Claude CLI installed globally (`npm install -g @anthropic-ai/claude-code`)
- ✅ Git CLI available for repository operations
- ✅ Thread follow-up support (same branch/PR)

### Key Implementation Details

1. **CLI invocation** via `execFile` with `stdio: ['ignore', 'pipe', 'pipe']` (stdin must be 'ignore' for non-interactive mode)
2. **JSON output parsing** via `--output-format json` flag
3. **Non-interactive mode** via `--print` flag
4. **Permissions bypassed** via `--dangerously-skip-permissions` flag

## Claude CLI Usage

### Basic Command

```bash
claude -p "Fix the bug described: $MESSAGE" \
  --cwd "/path/to/repo" \
  --allowedTools "Read,Edit,Write,Bash,Glob,Grep" \
  --permission-mode acceptEdits \
  --output-format json \
  --max-turns 50
```

### Streaming Output

```bash
claude -p "Fix the bug" \
  --output-format stream-json \
  2>&1 | while read -r line; do
    # Parse JSON and send to Slack
    echo "$line" | jq -r '.content // empty'
  done
```

### JSON Output Structure

```json
{
  "type": "result",
  "subtype": "success",
  "total_cost_usd": 0.15,
  "duration_ms": 45000,
  "duration_api_ms": 30000,
  "num_turns": 12,
  "result": "I've fixed the navigation bug...",
  "session_id": "abc123-def456"
}
```

### Error Output

```json
{
  "type": "result",
  "subtype": "error_max_turns",
  "total_cost_usd": 0.50,
  "duration_ms": 120000,
  "num_turns": 50,
  "result": "Reached maximum turns without completing...",
  "session_id": "abc123-def456"
}
```

## Environment Variables

### New Variables for CLI

```env
# Claude CLI Configuration
CLAUDE_CLI_PATH=claude                    # Path to claude binary
CLAUDE_MAX_TURNS=50                       # Max conversation turns
CLAUDE_PERMISSION_MODE=acceptEdits        # acceptEdits | plan | bypassPermissions
CLAUDE_OUTPUT_FORMAT=json                 # json | stream-json | text

# Optional: For resuming conversations
CLAUDE_SESSIONS_DIR=/tmp/claude-sessions
```

## File Changes

### 1. New Service: `src/services/claude/cli.ts`

Replaces `agent-sdk.ts` for Claude interactions.

### 2. Updated: `src/handlers/issue-processor.ts`

- Replace `claudeAgentService.run()` with `claudeCliService.run()`
- Add streaming support for real-time Slack updates

### 3. New: `src/services/claude/streaming.ts`

Handles parsing stream-json output and sending to Slack.

## Migration Path

1. **Phase 1:** ✅ Create CLI service, test locally
2. **Phase 2:** ✅ Deploy to Railway VM with job queue
3. **Phase 3:** ⏳ Add streaming support for real-time updates (future)
4. **Phase 4:** ✅ Add thread follow-ups for continuing work on same branch/PR

### Thread Follow-up Architecture

When a user replies in a completed thread:
1. Server checks `completedThreads` set and retrieves `ThreadContext`
2. `ThreadContext` contains: `branchName`, `prUrl`, `prNumber`, `originalIssueText`, `filesChanged`
3. Job processor calls `gitAutomationService.checkoutExistingBranch()` instead of creating new
4. Claude prompt includes context about original request and files changed
5. Changes push to existing branch, updating the same PR

## Testing

```bash
# Test Claude CLI directly
cd /path/to/target-repo
claude -p "What files are in this repo?" --output-format json

# Test with permission mode
claude -p "Fix the typo in README.md" \
  --permission-mode acceptEdits \
  --output-format json
```

## Cost Considerations

- Claude CLI tracks costs automatically in JSON output
- Set budget limits via `--max-turns` (prevents runaway costs)
- Typical fix: 5-20 turns, ~$0.10-0.50
- Complex features: 20-50 turns, ~$0.50-2.00

## Security Notes

1. **API Key:** Set `ANTHROPIC_API_KEY` environment variable
2. **File Access:** Claude CLI has full file system access - use `--cwd` to restrict
3. **Bash Commands:** Claude can run any bash command - consider allowedTools restrictions
4. **Git Credentials:** Store securely, never log tokens
