import { spawn, ChildProcess } from 'child_process';
import { logger } from '../../utils/logger.js';
import type { AgentResult, AgentProgress, AgentStats } from '../../types/index.js';
import type { PRDetails } from '../git/github-api.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
// Get path to local claude binary in node_modules
// Use process.cwd() which is the app root, not the dist folder
const CLAUDE_BIN = path.join(process.cwd(), 'node_modules', '.bin', 'claude');

/**
 * Claude CLI Service
 *
 * This service shells out to the Claude Code CLI (`claude` command) instead of
 * using the Agent SDK. This gives us full Claude Code capabilities:
 *
 * - MCP Servers (GitHub, databases, custom tools)
 * - Native Skills (.claude/skills/)
 * - Full tool access (Read, Edit, Bash, Glob, Grep, etc.)
 * - Can run npm/bun/yarn commands (if node_modules installed on VM)
 * - Conversation resume support
 * - Built-in cost tracking
 *
 * Prerequisites:
 * - Claude CLI installed: `npm install -g @anthropic-ai/claude-code`
 * - ANTHROPIC_API_KEY environment variable set
 */

// Image data for passing to Claude (downloaded from Slack)
export interface DownloadedImage {
  filename: string;
  mimetype: string;
  base64: string;
}

export interface ClaudeCliConfig {
  repoPath: string;
  maxTurns?: number;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
  outputFormat?: 'json' | 'stream-json' | 'text';
  allowedTools?: string[];
  onProgress?: (progress: AgentProgress) => void | Promise<void>;
  prContext?: PRDetails[];
  images?: DownloadedImage[];
  sessionId?: string; // For resuming conversations
}

/**
 * Result from Claude CLI JSON output
 */
interface ClaudeCliResult {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 'interrupted';
  total_cost_usd: number;
  duration_ms: number;
  duration_api_ms?: number;
  num_turns: number;
  result: string;
  session_id: string;
}

/**
 * Streaming message from Claude CLI
 */
interface ClaudeStreamMessage {
  type: 'assistant' | 'user' | 'system' | 'result';
  message?: {
    content?: Array<{
      type: 'text' | 'tool_use' | 'tool_result';
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
      id?: string;
    }>;
  };
  subtype?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  result?: string;
}

/**
 * Save downloaded images to temp directory for Claude to read
 */
async function saveImagesToTemp(images: DownloadedImage[]): Promise<string[]> {
  const tempDir = path.join(os.tmpdir(), 'claude-cli-images');
  await fs.mkdir(tempDir, { recursive: true });

  const savedPaths: string[] = [];

  for (const image of images) {
    try {
      const filename = `${Date.now()}-${image.filename}`;
      const filepath = path.join(tempDir, filename);
      const buffer = Buffer.from(image.base64, 'base64');
      await fs.writeFile(filepath, buffer);
      savedPaths.push(filepath);
      logger.debug('Saved image to temp', { filepath, sizeKb: Math.round(buffer.length / 1024) });
    } catch (error) {
      logger.warn('Failed to save image to temp', {
        filename: image.filename,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return savedPaths;
}

/**
 * Clean up temp images after processing
 */
async function cleanupTempImages(paths: string[]): Promise<void> {
  for (const filepath of paths) {
    try {
      await fs.unlink(filepath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Format PR context into a readable string for Claude
 */
function formatPRContext(prDetails: PRDetails[]): string {
  if (prDetails.length === 0) return '';

  const sections: string[] = [];

  for (const pr of prDetails) {
    const prSection: string[] = [];
    prSection.push(`### PR #${pr.number}: ${pr.title}`);
    prSection.push(`- **State:** ${pr.state}`);
    prSection.push(`- **Author:** ${pr.author}`);
    prSection.push(`- **Branch:** \`${pr.branch}\` → \`${pr.baseBranch}\``);
    prSection.push(`- **URL:** ${pr.url}`);

    if (pr.body) {
      prSection.push(`\n**Description:**\n${pr.body.substring(0, 1000)}${pr.body.length > 1000 ? '...' : ''}`);
    }

    // Include files changed with their patches (limited to most important ones)
    if (pr.files.length > 0) {
      prSection.push(`\n**Files Changed (${pr.files.length}):**`);
      const sortedFiles = [...pr.files].sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions)).slice(0, 10);
      for (const file of sortedFiles) {
        prSection.push(`- \`${file.filename}\` (${file.status}, +${file.additions}/-${file.deletions})`);
        if (file.patch && file.patch.length < 1500) {
          prSection.push('```diff');
          prSection.push(file.patch);
          prSection.push('```');
        }
      }
      if (pr.files.length > 10) {
        prSection.push(`... and ${pr.files.length - 10} more files`);
      }
    }

    // Include review comments
    if (pr.reviews.length > 0) {
      prSection.push(`\n**Reviews:**`);
      for (const review of pr.reviews.slice(0, 5)) {
        prSection.push(`- ${review.author} (${review.state}): ${review.body.substring(0, 200)}${review.body.length > 200 ? '...' : ''}`);
      }
    }

    // Include PR comments
    if (pr.comments.length > 0) {
      prSection.push(`\n**Comments:**`);
      for (const comment of pr.comments.slice(0, 5)) {
        prSection.push(`- ${comment.author}: ${comment.body.substring(0, 200)}${comment.body.length > 200 ? '...' : ''}`);
      }
    }

    sections.push(prSection.join('\n'));
  }

  return sections.join('\n\n---\n\n');
}

/**
 * Build the prompt for Claude CLI
 * Since CLI reads CLAUDE.md automatically, we keep this focused on the task
 */
function buildPrompt(
  issueDescription: string,
  prContext?: PRDetails[],
  imagePaths?: string[]
): string {
  const prContextStr = prContext && prContext.length > 0
    ? `\n\n## Referenced Pull Request(s)\n\nThe user has referenced the following PR(s). Please review them carefully:\n\n${formatPRContext(prContext)}`
    : '';

  const imageContextStr = imagePaths && imagePaths.length > 0
    ? `\n\n## Screenshots/Images Attached\n\n${imagePaths.length} screenshot(s) attached. Read these images first:\n${imagePaths.map((p, i) => `${i + 1}. \`${p}\``).join('\n')}`
    : '';

  return `## Issue to Fix

${issueDescription}${prContextStr}${imageContextStr}

## Instructions

Please analyze this issue and implement a fix:
${imagePaths && imagePaths.length > 0 ? '0. **FIRST: Read the attached screenshot(s)**\n' : ''}1. Read CLAUDE.md files to understand the codebase conventions
2. Explore the codebase to understand the structure
3. Investigate the specific problem
4. Implement a surgical fix using the Edit tool
5. Verify your changes

**IMPORTANT:** Do NOT commit, push, or create PRs. The system handles all git operations automatically after you finish making changes.`;
}

/**
 * Run Claude CLI and return the result
 */
export async function runClaudeCli(
  issueDescription: string,
  config: ClaudeCliConfig
): Promise<AgentResult> {
  const startTime = Date.now();
  const maxTurns = config.maxTurns ?? 50;
  const permissionMode = config.permissionMode ?? 'acceptEdits';
  const outputFormat = config.outputFormat ?? 'stream-json';
  const allowedTools = config.allowedTools ?? ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];

  logger.info('🖥️ Starting Claude CLI', {
    issue: issueDescription.substring(0, 100),
    repoPath: config.repoPath,
    maxTurns,
    permissionMode,
    outputFormat,
    hasPRContext: (config.prContext?.length ?? 0) > 0,
    hasImages: (config.images?.length ?? 0) > 0,
    sessionId: config.sessionId,
  });

  // Track progress for Slack updates
  const progressEvents: AgentProgress[] = [];
  let currentPhase: AgentProgress['phase'] = 'exploring';
  let filesModified: string[] = [];
  let commandsRun: string[] = [];

  // Save images to temp files
  let savedImagePaths: string[] = [];
  if (config.images && config.images.length > 0) {
    logger.info('📷 Saving images for Claude CLI', { count: config.images.length });
    savedImagePaths = await saveImagesToTemp(config.images);
  }

  try {
    // Build the prompt
    const prompt = buildPrompt(issueDescription, config.prContext, savedImagePaths);

    // Build CLI arguments
    // Note: Working directory is set via spawn cwd option, not --cwd flag
    // Note: --verbose is required when using --output-format=stream-json with --print
    const args: string[] = [
      '-p', prompt,
      '--permission-mode', permissionMode,
      '--output-format', outputFormat,
      '--max-turns', maxTurns.toString(),
      '--allowedTools', allowedTools.join(','),
      // Debug mode to see internal CLI activity
      '--debug', 'api,auth',
    ];

    // stream-json requires --verbose flag
    if (outputFormat === 'stream-json') {
      args.push('--verbose');
    }

    // Disable MCP servers in serverless environment (they can hang or timeout)
    // --strict-mcp-config ignores user/project MCP configs, only uses --mcp-config
    // Write empty config to temp file to avoid any shell escaping issues
    const mcpConfigPath = path.join(os.tmpdir(), 'claude-mcp-config.json');
    await fs.writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
    args.push('--strict-mcp-config');
    args.push('--mcp-config', mcpConfigPath);

    // Add session ID for resume if provided
    if (config.sessionId) {
      args.push('--resume', config.sessionId);
    }

    // Check that API key is available
    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
    const apiKeyPrefix = process.env.ANTHROPIC_API_KEY?.substring(0, 10) || 'NOT SET';

    logger.info('Claude CLI command details', {
      command: CLAUDE_BIN,
      promptLength: prompt.length,
      hasApiKey,
      apiKeyPrefix: `${apiKeyPrefix}...`,
      argsPreview: args.map((a, i) => i === 1 ? `[prompt: ${a.substring(0, 50)}...]` : a).join(' '),
    });

    // Spawn the Claude CLI process in the repo directory
    logger.info('🔧 Spawning Claude CLI process', {
      bin: CLAUDE_BIN,
      cwd: config.repoPath,
      argsCount: args.length,
    });

    // Log all environment variables being passed (sanitized)
    const envKeys = Object.keys(process.env).filter(k => !k.includes('TOKEN') && !k.includes('KEY') && !k.includes('SECRET'));
    logger.info('🔑 Environment check', {
      envKeyCount: Object.keys(process.env).length,
      sampleKeys: envKeys.slice(0, 20),
      hasHome: !!process.env.HOME,
      home: process.env.HOME,
      hasTerm: !!process.env.TERM,
      term: process.env.TERM,
      nodeVersion: process.version,
    });

    const claudeProcess = spawn(CLAUDE_BIN, args, {
      cwd: config.repoPath,  // Set working directory to the target repo
      env: {
        ...process.env,
        // Explicitly ensure ANTHROPIC_API_KEY is passed
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        // Disable any interactive prompts - critical for serverless
        CI: 'true',
        // Set HOME to a writable directory for any config the CLI might need
        HOME: process.env.HOME || '/tmp',
        // Disable telemetry and non-essential traffic for serverless environments
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        // Force non-interactive mode
        NONINTERACTIVE: '1',
        // Ensure no TTY allocation
        TERM: 'dumb',
        // Force unbuffered output
        PYTHONUNBUFFERED: '1',
        NODE_NO_WARNINGS: '1',
        // Force Ink to not use raw mode (critical for serverless environments)
        FORCE_COLOR: '0',
      },
      // Use 'ignore' for stdin to prevent Ink's raw mode check from failing.
      // In non-TTY environments (like Railway), piped stdin causes Ink to crash
      // when it tries to set raw mode on the input stream.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    logger.info('🚀 Claude CLI process spawned', { pid: claudeProcess.pid, stdinMode: 'ignore' });

    // Log the full command for debugging in Railway
    const fullCommand = `${CLAUDE_BIN} ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`;
    logger.info('📝 Full CLI command', { command: fullCommand.substring(0, 500) });

    // Log first data immediately to help debug silent processes
    let hasReceivedAnyOutput = false;
    const outputTimeout = setTimeout(() => {
      if (!hasReceivedAnyOutput) {
        logger.warn('⚠️ Claude CLI: No output received after 15 seconds', {
          pid: claudeProcess.pid,
          killed: claudeProcess.killed,
          exitCode: claudeProcess.exitCode,
        });
      }
    }, 15000);

    // Set up a heartbeat to detect if process is alive but silent
    const heartbeatInterval = setInterval(() => {
      logger.info('💓 Claude CLI heartbeat', {
        pid: claudeProcess.pid,
        killed: claudeProcess.killed,
        exitCode: claudeProcess.exitCode,
        signalCode: claudeProcess.signalCode,
        stdoutBufferLength: stdoutBuffer?.length ?? 0,
        stderrBufferLength: stderrBuffer?.length ?? 0,
      });
    }, 30000); // Log every 30 seconds

    // Collect output
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let lastResult: ClaudeCliResult | null = null;
    let assistantMessages: string[] = [];

    // Handle streaming output
    claudeProcess.stdout.on('data', async (data: Buffer) => {
      const chunk = data.toString();
      stdoutBuffer += chunk;

      // Mark that we've received output and clear the warning timeout
      if (!hasReceivedAnyOutput) {
        hasReceivedAnyOutput = true;
        clearTimeout(outputTimeout);
        logger.info('✅ Claude CLI: First output received', {
          chunkLength: chunk.length,
          preview: chunk.substring(0, 100),
        });
      }

      // Log raw output for debugging
      logger.debug('📥 Claude CLI stdout chunk', {
        chunkLength: chunk.length,
        preview: chunk.substring(0, 200),
        totalBuffered: stdoutBuffer.length,
      });

      // Process line by line for stream-json format
      if (outputFormat === 'stream-json') {
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || ''; // Keep incomplete line

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const message: ClaudeStreamMessage = JSON.parse(line);
            await processStreamMessage(message);
          } catch {
            // Not valid JSON, skip
            logger.debug('Non-JSON output from Claude CLI', { line: line.substring(0, 100) });
          }
        }
      }
    });

    claudeProcess.stderr.on('data', (data: Buffer) => {
      const errChunk = data.toString();
      stderrBuffer += errChunk;
      logger.warn('⚠️ Claude CLI stderr', { stderr: errChunk.substring(0, 500) });
    });

    // Log when process events occur
    claudeProcess.on('spawn', () => {
      logger.info('✅ Claude CLI process spawned successfully');
    });

    claudeProcess.on('error', (err) => {
      logger.error('❌ Claude CLI process error', { error: err.message });
    });

    // Process streaming messages
    async function processStreamMessage(message: ClaudeStreamMessage) {
      switch (message.type) {
        case 'system':
          if (message.subtype === 'init') {
            logger.debug('Claude CLI session initialized', { sessionId: message.session_id });
            const initProgress: AgentProgress = {
              phase: 'exploring',
              message: 'Starting analysis...',
              timestamp: new Date(),
            };
            progressEvents.push(initProgress);
            await config.onProgress?.(initProgress);
          }
          break;

        case 'assistant':
          if (message.message?.content) {
            for (const block of message.message.content) {
              if (block.type === 'text' && block.text) {
                assistantMessages.push(block.text);

                // Detect phase from content
                const text = block.text.toLowerCase();
                let newPhase: AgentProgress['phase'] = currentPhase;
                if (text.includes('exploring') || text.includes('searching')) {
                  newPhase = 'exploring';
                } else if (text.includes('reading') || text.includes('analyzing')) {
                  newPhase = 'analyzing';
                } else if (text.includes('editing') || text.includes('fixing')) {
                  newPhase = 'fixing';
                } else if (text.includes('running') || text.includes('testing')) {
                  newPhase = 'testing';
                }

                if (newPhase !== currentPhase) {
                  currentPhase = newPhase;
                  const phaseProgress: AgentProgress = {
                    phase: currentPhase,
                    message: block.text.substring(0, 200),
                    timestamp: new Date(),
                  };
                  progressEvents.push(phaseProgress);
                  await config.onProgress?.(phaseProgress);
                }
              } else if (block.type === 'tool_use' && block.name) {
                const toolInput = block.input || {};
                let detail = '';

                if (block.name === 'Read' || block.name === 'Edit' || block.name === 'Write') {
                  const filePath = (toolInput.file_path || toolInput.path) as string;
                  detail = filePath || '';
                  if ((block.name === 'Edit' || block.name === 'Write') && filePath) {
                    if (!filesModified.includes(filePath)) {
                      filesModified.push(filePath);
                    }
                  }
                } else if (block.name === 'Bash') {
                  const command = toolInput.command as string;
                  detail = command?.substring(0, 50) || '';
                  if (command) {
                    commandsRun.push(command);
                  }
                } else if (block.name === 'Glob' || block.name === 'Grep') {
                  detail = (toolInput.pattern as string) || '';
                }

                const toolProgress: AgentProgress = {
                  phase: currentPhase,
                  message: `Using ${block.name}${detail ? `: ${detail}` : ''}`,
                  tool: block.name,
                  detail,
                  timestamp: new Date(),
                };
                progressEvents.push(toolProgress);
                await config.onProgress?.(toolProgress);

                logger.debug('Tool used', { tool: block.name, detail: detail.substring(0, 100) });
              }
            }
          }
          break;

        case 'result':
          lastResult = message as unknown as ClaudeCliResult;
          logger.debug('Claude CLI result received', {
            subtype: message.subtype,
            cost: message.total_cost_usd,
            turns: message.num_turns,
          });
          break;
      }
    }

    // Wait for process to complete
    const exitCode = await new Promise<number>((resolve, reject) => {
      claudeProcess.on('close', (code) => {
        clearInterval(heartbeatInterval);
        clearTimeout(outputTimeout);
        logger.info('🏁 Claude CLI process closed', {
          exitCode: code,
          hasReceivedAnyOutput,
          stdoutLength: stdoutBuffer.length,
          stderrLength: stderrBuffer.length,
        });
        resolve(code ?? 1);
      });
      claudeProcess.on('error', (err) => {
        clearInterval(heartbeatInterval);
        clearTimeout(outputTimeout);
        logger.error('❌ Claude CLI process error event', { error: err.message });
        reject(err);
      });
    });

    const duration = Date.now() - startTime;

    // Handle non-streaming JSON output
    if (outputFormat === 'json' && !lastResult && stdoutBuffer.trim()) {
      try {
        lastResult = JSON.parse(stdoutBuffer.trim());
      } catch {
        logger.warn('Failed to parse Claude CLI JSON output', { output: stdoutBuffer.substring(0, 500) });
      }
    }

    // Process any remaining stdout buffer
    if (stdoutBuffer.trim()) {
      const lines = stdoutBuffer.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const message: ClaudeStreamMessage = JSON.parse(line);
          if (message.type === 'result') {
            lastResult = message as unknown as ClaudeCliResult;
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }

    // Build result
    const isSuccess = exitCode === 0 && lastResult?.subtype === 'success';

    const stats: AgentStats = {
      durationMs: lastResult?.duration_ms ?? duration,
      costUsd: lastResult?.total_cost_usd ?? 0,
      turns: lastResult?.num_turns ?? 0,
      inputTokens: 0, // CLI doesn't provide this
      outputTokens: 0,
    };

    // Report completion
    const completeProgress: AgentProgress = {
      phase: 'complete',
      message: isSuccess ? 'Fix complete!' : 'Fix failed',
      timestamp: new Date(),
    };
    progressEvents.push(completeProgress);
    await config.onProgress?.(completeProgress);

    logger.info('Claude CLI completed', {
      success: isSuccess,
      exitCode,
      duration: `${(duration / 1000).toFixed(1)}s`,
      cost: `$${stats.costUsd.toFixed(4)}`,
      turns: stats.turns,
      filesModified: filesModified.length,
      sessionId: lastResult?.session_id,
    });

    const result: AgentResult = {
      success: isSuccess,
      analysis: lastResult?.result || assistantMessages.join('\n\n'),
      filesModified,
      commandsRun,
      stats,
      error: !isSuccess ? (stderrBuffer || `Exit code: ${exitCode}`) : undefined,
    };

    // Attach session ID for potential resume
    (result as any).sessionId = lastResult?.session_id;

    return result;

  } catch (error) {
    const duration = Date.now() - startTime;

    // Note: heartbeatInterval may not exist if error occurred before it was set
    // TypeScript knows it might be undefined due to scoping

    logger.error('Claude CLI error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      duration: `${(duration / 1000).toFixed(1)}s`,
    });

    // Report error progress
    const errorProgress: AgentProgress = {
      phase: 'complete',
      message: `Error: ${error instanceof Error ? error.message : String(error)}`,
      timestamp: new Date(),
    };
    progressEvents.push(errorProgress);
    await config.onProgress?.(errorProgress);

    return {
      success: false,
      analysis: '',
      filesModified: [],
      commandsRun: [],
      stats: {
        durationMs: duration,
        costUsd: 0,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Clean up temp images
    if (savedImagePaths.length > 0) {
      logger.debug('Cleaning up temp images', { count: savedImagePaths.length });
      await cleanupTempImages(savedImagePaths);
    }
  }
}

/**
 * Check if Claude CLI is installed and accessible
 */
export async function checkClaudeCliInstalled(): Promise<{
  installed: boolean;
  version?: string;
  error?: string;
}> {
  return new Promise((resolve) => {
    logger.debug('Checking Claude CLI at path', { path: CLAUDE_BIN });
    const process = spawn(CLAUDE_BIN, ['--version'], {
      // Use 'ignore' for stdin to prevent Ink raw mode issues
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    process.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    process.on('close', (code) => {
      if (code === 0) {
        const version = stdout.trim().match(/\d+\.\d+\.\d+/)?.[0];
        resolve({ installed: true, version });
      } else {
        resolve({ installed: false, error: stderr || 'Claude CLI not found' });
      }
    });

    process.on('error', (error) => {
      resolve({
        installed: false,
        error: `Claude CLI not found: ${error.message}. Install with: npm install -g @anthropic-ai/claude-code`,
      });
    });
  });
}

/**
 * Service class wrapper for consistency with existing codebase
 */
class ClaudeCliService {
  /**
   * Check if Claude CLI is installed
   */
  async checkInstalled() {
    return checkClaudeCliInstalled();
  }

  /**
   * Analyze an issue and generate a fix using Claude CLI
   */
  async analyzeAndFix(
    issueDescription: string,
    config: ClaudeCliConfig
  ): Promise<AgentResult> {
    return runClaudeCli(issueDescription, config);
  }
}

// Export singleton instance
export const claudeCliService = new ClaudeCliService();
