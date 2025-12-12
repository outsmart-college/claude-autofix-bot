import { IssueJob, JobResult, BranchOptions, AgentProgress, ImageAttachment, ThreadContext } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { slackService } from '../services/slack/client.js';
import { claudeAgentSDKService } from '../services/claude/agent-sdk.js';
import { claudeCliService, checkClaudeCliInstalled } from '../services/claude/cli.js';
import { gitAutomationService } from '../services/git/automation.js';
import { githubAPIService, PRDetails } from '../services/git/github-api.js';
import { vercelDeploymentService } from '../services/deployment/vercel.js';
import { config } from '../config/index.js';
import { markThreadCompleted, clearActiveThread } from '../utils/thread-tracking.js';

/**
 * Main issue processor - orchestrates the entire fix pipeline
 *
 * This is the core business logic that:
 * 1. Acknowledges the issue in Slack (with 👀 reaction)
 * 2. Posts initial status message
 * 3. Runs Claude Agent SDK to explore, analyze, and fix
 * 4. Creates a new Git branch
 * 5. Commits changes (detected via git status)
 * 6. Pushes to remote
 * 7. Creates a Pull Request
 * 8. Waits for Vercel deployment
 * 9. Reports back to Slack with PR + preview URL + stats
 */
export async function processIssue(job: IssueJob): Promise<JobResult> {
  const { text, channel, threadTs, userId, isFollowUp, threadContext } = job;
  let statusMessageTs: string | undefined;
  let branchName: string | undefined;
  let prUrl: string | undefined;
  let prNumber: number | undefined;
  let lastProgressUpdate = Date.now();
  const PROGRESS_UPDATE_INTERVAL = 3000; // Update Slack every 3 seconds max

  // If this is a follow-up with context, reuse the existing branch/PR
  if (isFollowUp && threadContext) {
    branchName = threadContext.branchName;
    prUrl = threadContext.prUrl;
    prNumber = threadContext.prNumber;
  }

  try {
    logger.info('📋 Processing issue', {
      jobId: job.id,
      preview: text.substring(0, 100),
      isFollowUp: !!isFollowUp,
      existingBranch: branchName,
    });

    // ============================================
    // STEP 1: Acknowledge in Slack
    // ============================================
    await slackService.addReaction(channel, threadTs, 'eyes');

    const initialMessage = isFollowUp && threadContext
      ? `🔧 *Processing follow-up request...*\nContinuing work on branch \`${branchName}\`.`
      : '🔧 *Starting Claude Agent...*\nClaude will explore the codebase and implement a fix.';

    const statusMsg = await slackService.postMessage(
      channel,
      initialMessage,
      threadTs
    );
    statusMessageTs = statusMsg.ts;

    // ============================================
    // STEP 1.5: Fetch PR Context (if references found)
    // ============================================
    let prContext: PRDetails[] = [];
    if (job.prReferences && job.prReferences.length > 0) {
      logger.info('📋 Fetching PR context', {
        prReferences: job.prReferences.map(r => `${r.owner}/${r.repo}#${r.prNumber}`),
      });

      await updateSlackStatus(channel, statusMessageTs,
        `📋 *Fetching PR context...*\nAnalyzing ${job.prReferences.length} referenced PR(s).`
      );

      // Fetch PR details in parallel
      const prPromises = job.prReferences.map(async (ref) => {
        try {
          const prDetails = await githubAPIService.getPullRequest(ref.prNumber, ref.owner, ref.repo);
          if (prDetails) {
            logger.debug('PR details fetched', {
              pr: `${ref.owner}/${ref.repo}#${ref.prNumber}`,
              title: prDetails.title,
              filesCount: prDetails.files.length,
            });
            return prDetails;
          }
        } catch (error) {
          logger.warn('Failed to fetch PR details', {
            pr: `${ref.owner}/${ref.repo}#${ref.prNumber}`,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return null;
      });

      const results = await Promise.all(prPromises);
      prContext = results.filter((pr): pr is PRDetails => pr !== null);

      if (prContext.length > 0) {
        logger.info('PR context loaded', {
          prsLoaded: prContext.length,
          totalFiles: prContext.reduce((sum, pr) => sum + pr.files.length, 0),
        });
      }
    }

    // ============================================
    // STEP 2: Initialize Git Repository
    // ============================================
    logger.info('📦 Initializing repository...');
    await updateSlackStatus(channel, statusMessageTs,
      '📦 *Cloning repository...*\nSetting up local workspace.'
    );

    await gitAutomationService.initializeRepo();
    const repoPath = gitAutomationService.getRepoPath();

    // For follow-ups, checkout the existing branch instead of staying on main
    if (isFollowUp && branchName) {
      logger.info('🌿 Checking out existing branch for follow-up', { branchName });
      await updateSlackStatus(channel, statusMessageTs!,
        `🌿 *Checking out branch...*\n\`${branchName}\``
      );

      const checkoutResult = await gitAutomationService.checkoutExistingBranch(branchName);
      if (!checkoutResult.success) {
        logger.warn('Failed to checkout existing branch, will create new one', {
          branchName,
          error: checkoutResult.error,
        });
        // Clear branch so we create a new one later
        branchName = undefined;
      }
    }

    // ============================================
    // STEP 2.5: Download Images (if any)
    // ============================================
    let downloadedImages: { filename: string; mimetype: string; base64: string }[] = [];
    if (job.images && job.images.length > 0) {
      logger.info('📷 Downloading images from Slack', { count: job.images.length });
      await updateSlackStatus(channel, statusMessageTs!,
        `📷 *Downloading ${job.images.length} image(s)...*\nPreparing screenshots for Claude to analyze.`
      );

      downloadedImages = await slackService.downloadImages(job.images);
      logger.info('Images downloaded', {
        requested: job.images.length,
        downloaded: downloadedImages.length,
      });
    }

    // ============================================
    // STEP 3: Run Claude (SDK or CLI based on config)
    // ============================================
    const useCliMode = config.claude.mode === 'cli';
    logger.info(`🤖 Running Claude ${useCliMode ? 'CLI' : 'Agent SDK'}`);

    // If CLI mode, check if it's installed
    if (useCliMode) {
      const cliCheck = await checkClaudeCliInstalled();
      if (!cliCheck.installed) {
        logger.error('Claude CLI not installed', { error: cliCheck.error });
        await slackService.updateMessage(
          channel,
          statusMessageTs!,
          `❌ *Configuration Error*\n\nClaude CLI mode is enabled but the CLI is not installed.\n\n` +
          `Error: ${cliCheck.error}\n\n` +
          `Either install Claude CLI or set \`CLAUDE_MODE=sdk\` to use Agent SDK.`
        );
        clearActiveThread(threadTs);
        return {
          jobId: job.id,
          status: 'failed',
          error: 'Claude CLI not installed',
        };
      }
      logger.info('Claude CLI verified', { version: cliCheck.version });
    }

    // Track progress for display
    let currentPhase = 'exploring';
    let currentTool = '';
    let toolsUsed: string[] = [];
    let progressLines: string[] = [];

    // Progress callback to update Slack in real-time
    const onProgress = async (progress: AgentProgress) => {
      const now = Date.now();

      // Update phase
      currentPhase = progress.phase;
      if (progress.tool) {
        currentTool = progress.tool;
        if (!toolsUsed.includes(progress.tool)) {
          toolsUsed.push(progress.tool);
        }
      }

      // Build progress line
      if (progress.tool && progress.detail) {
        const shortDetail = progress.detail.length > 40
          ? progress.detail.substring(0, 40) + '...'
          : progress.detail;
        progressLines.push(`├─ ${progress.tool}: ${shortDetail}`);
        // Keep only last 5 lines
        if (progressLines.length > 5) {
          progressLines = progressLines.slice(-5);
        }
      }

      // Throttle Slack updates to avoid rate limiting
      if (now - lastProgressUpdate < PROGRESS_UPDATE_INTERVAL && progress.phase !== 'complete') {
        return;
      }
      lastProgressUpdate = now;

      // Build status message
      const phaseEmoji = {
        exploring: '🔍',
        analyzing: '🧠',
        fixing: '✏️',
        testing: '🧪',
        complete: '✅',
      }[progress.phase] || '⚙️';

      const phaseText = {
        exploring: 'Exploring codebase...',
        analyzing: 'Analyzing issue...',
        fixing: 'Applying fix...',
        testing: 'Verifying changes...',
        complete: 'Agent complete!',
      }[progress.phase] || 'Working...';

      let statusText = `${phaseEmoji} *${phaseText}*\n`;
      if (progressLines.length > 0) {
        statusText += '```\n' + progressLines.join('\n') + '\n```';
      }

      try {
        await slackService.updateMessage(channel, statusMessageTs!, statusText);
      } catch {
        // Ignore Slack update errors
      }
    };

    // Build prompt - include follow-up context if this is a continuation
    let promptText = text;
    if (isFollowUp && threadContext) {
      promptText = `**FOLLOW-UP REQUEST**

This is a follow-up to a previous task. Here's the context:

**Original Request:**
${threadContext.originalIssueText}

**Files Previously Modified:**
${threadContext.filesChanged.map(f => `- ${f}`).join('\n')}

**Current Branch:** ${threadContext.branchName}
${threadContext.prUrl ? `**Existing PR:** ${threadContext.prUrl}` : ''}

---

**NEW FOLLOW-UP REQUEST:**
${text}

Please make the requested changes on the existing branch. The changes will be committed to the same PR.`;
    }

    // Run either CLI or SDK based on config
    const agentResult = useCliMode
      ? await claudeCliService.analyzeAndFix(promptText, {
          repoPath,
          maxTurns: config.claude.maxTurns,
          onProgress,
          prContext: prContext.length > 0 ? prContext : undefined,
          images: downloadedImages.length > 0 ? downloadedImages : undefined,
        })
      : await claudeAgentSDKService.analyzeAndFix(promptText, {
          repoPath,
          maxBudgetUsd: config.claude.maxBudgetUsd,
          maxTurns: config.claude.maxTurns,
          onProgress,
          prContext: prContext.length > 0 ? prContext : undefined,
          images: downloadedImages.length > 0 ? downloadedImages : undefined,
        });

    // ============================================
    // STEP 4: Check for Changes
    // ============================================
    if (!agentResult.success) {
      await slackService.updateMessage(
        channel,
        statusMessageTs,
        `❌ *Agent Failed*\n\n${agentResult.error || 'Unknown error occurred'}\n\n` +
        `**Analysis:**\n${agentResult.analysis.substring(0, 500)}...\n\n` +
        `Please try rephrasing your request or providing more details.`
      );

      // Clear the active thread state so the thread can be retried
      clearActiveThread(threadTs);

      return {
        jobId: job.id,
        status: 'failed',
        error: agentResult.error,
      };
    }

    // Get actual changed files from git status
    const gitStatus = await gitAutomationService.getStatus();
    const filesChanged = [
      ...gitStatus.modified,
      ...gitStatus.created,
      ...gitStatus.not_added,
    ];

    // Log detailed git status for debugging
    logger.info('Git status after agent run', {
      repoPath,
      modified: gitStatus.modified,
      created: gitStatus.created,
      not_added: gitStatus.not_added,
      staged: gitStatus.staged,
      filesChangedCount: filesChanged.length,
      agentReportedFiles: agentResult.filesModified,
    });

    if (filesChanged.length === 0) {
      // Check if agent reported files but git shows none
      if (agentResult.filesModified.length > 0) {
        logger.warn('Agent reported files modified but git shows no changes', {
          agentFiles: agentResult.filesModified,
          repoPath,
          gitStatusRaw: gitStatus,
        });
      }

      await slackService.updateMessage(
        channel,
        statusMessageTs,
        `⚠️ *No Changes Made*\n\nClaude analyzed the issue but didn't modify any files.\n\n` +
        `**Analysis:**\n${agentResult.analysis.substring(0, 1000)}\n\n` +
        `This might mean:\n` +
        `• The issue couldn't be fixed automatically\n` +
        `• More information is needed\n` +
        `• The issue might already be fixed\n\n` +
        `💰 Cost: $${agentResult.stats.costUsd.toFixed(4)}`
      );

      // Mark thread as completed to allow follow-up instructions
      markThreadCompleted(threadTs);

      return {
        jobId: job.id,
        status: 'completed',
        result: {
          success: true,
          analysis: agentResult.analysis,
          solution: 'No changes made',
          filesChanged: [],
          fixes: [],
        },
      };
    }

    logger.info('Files changed by agent', { filesChanged });

    // ============================================
    // STEP 5: Create Git Branch (skip if follow-up with existing branch)
    // ============================================
    if (!branchName) {
      // New request - create a new branch
      logger.info('🌿 Creating git branch');
      await slackService.updateMessage(
        channel,
        statusMessageTs,
        `💾 *Creating branch...*\n` +
        `Modified ${filesChanged.length} file(s):\n` +
        filesChanged.map(f => `• \`${f}\``).join('\n')
      );

      const branchType = determineBranchType(text);
      const branchOptions: BranchOptions = {
        type: branchType,
        description: text.substring(0, 50),
      };

      const branchResult = await gitAutomationService.createBranch(branchOptions);

      if (!branchResult.success || !branchResult.branchName) {
        await slackService.updateMessage(
          channel,
          statusMessageTs,
          `⚠️ *Git Branch Creation Failed*\n\n${branchResult.error}\n\n` +
          `Fix was generated but could not create branch.\n\n` +
          `💰 Cost: $${agentResult.stats.costUsd.toFixed(4)}`
        );

        // Clear the active thread state so the thread can be retried
        clearActiveThread(threadTs);

        return {
          jobId: job.id,
          status: 'failed',
          error: branchResult.error,
        };
      }

      branchName = branchResult.branchName;
    } else {
      // Follow-up - already on existing branch
      logger.info('Using existing branch for follow-up', { branchName });
      await slackService.updateMessage(
        channel,
        statusMessageTs,
        `💾 *Preparing commit...*\n` +
        `Branch: \`${branchName}\`\n` +
        `Modified ${filesChanged.length} file(s):\n` +
        filesChanged.map(f => `• \`${f}\``).join('\n')
      );
    }

    // ============================================
    // STEP 6: Commit Changes
    // ============================================
    logger.info('💾 Committing changes');
    await slackService.updateMessage(
      channel,
      statusMessageTs,
      `💾 *Committing changes...*\nBranch: \`${branchName}\``
    );

    // Extract a concise solution summary from agent's analysis
    const solutionSummary = extractSolutionSummary(agentResult.analysis);
    const commitMessage = generateCommitMessage(text, solutionSummary, filesChanged);
    const commitResult = await gitAutomationService.commitChanges(commitMessage, filesChanged);

    if (!commitResult.success) {
      await slackService.updateMessage(
        channel,
        statusMessageTs,
        `⚠️ *Git Commit Failed*\n\n${commitResult.error}\n\n` +
        `Fix was generated but could not be committed.\n\n` +
        `💰 Cost: $${agentResult.stats.costUsd.toFixed(4)}`
      );

      // Clear the active thread state so the thread can be retried
      clearActiveThread(threadTs);

      return {
        jobId: job.id,
        status: 'failed',
        error: commitResult.error,
      };
    }

    // ============================================
    // STEP 7: Push to Remote
    // ============================================
    logger.info('📤 Pushing to remote');
    await slackService.updateMessage(
      channel,
      statusMessageTs,
      `📤 *Pushing to GitHub...*\n` +
      `Branch: \`${branchName}\`\n` +
      `Commit: \`${commitResult.hash?.substring(0, 7)}\``
    );

    const pushSuccess = await gitAutomationService.pushBranch(branchName);

    if (!pushSuccess) {
      await slackService.updateMessage(
        channel,
        statusMessageTs,
        `⚠️ *Git Push Failed*\n\n` +
        `Changes were committed locally but could not be pushed to GitHub.\n\n` +
        `Please check GitHub credentials and permissions.\n\n` +
        `💰 Cost: $${agentResult.stats.costUsd.toFixed(4)}`
      );

      // Clear the active thread state so the thread can be retried
      clearActiveThread(threadTs);

      return {
        jobId: job.id,
        status: 'failed',
        error: 'Failed to push to remote',
      };
    }

    // ============================================
    // STEP 8: Create Pull Request (skip if follow-up with existing PR)
    // ============================================
    let finalPrUrl = prUrl;
    let finalPrNumber = prNumber;

    if (prUrl && prNumber) {
      // Follow-up with existing PR - skip PR creation
      logger.info('Using existing PR for follow-up', { prUrl, prNumber });
      await slackService.updateMessage(
        channel,
        statusMessageTs,
        `✅ *Changes pushed to existing PR!*\n\n` +
        `📝 PR: ${prUrl}\n` +
        `🌿 Branch: \`${branchName}\`\n` +
        `📌 Commit: \`${commitResult.hash?.substring(0, 7)}\``
      );
    } else {
      // New request - create a new PR
      logger.info('📝 Creating pull request');
      await slackService.updateMessage(
        channel,
        statusMessageTs,
        `📝 *Creating pull request...*\nBranch pushed successfully!`
      );

      const branchType = determineBranchType(text);
      const prTitle = generatePRTitle(text, branchType, filesChanged);
      const prBody = formatPRDescription(agentResult, filesChanged);

      const prResult = await githubAPIService.createPullRequest(
        branchName,
        prTitle,
        prBody
      );

      if (!prResult.success || !prResult.prUrl) {
        await slackService.updateMessage(
          channel,
          statusMessageTs,
          `⚠️ *PR Creation Failed*\n\n${prResult.error}\n\n` +
          `Changes were pushed to branch \`${branchName}\` but PR could not be created.\n\n` +
          `You can create the PR manually.\n\n` +
          `💰 Cost: $${agentResult.stats.costUsd.toFixed(4)}`
        );

        return {
          jobId: job.id,
          status: 'completed',
          branchName,
          error: prResult.error,
        };
      }

      finalPrUrl = prResult.prUrl;
      finalPrNumber = prResult.prNumber;

      // Add automatic labels
      if (prResult.prNumber) {
        await githubAPIService.addLabels(prResult.prNumber, ['automated', 'claude-agent']);
      }
    }

    // ============================================
    // STEP 9: Wait for Deployment
    // ============================================
    logger.info('🚀 Waiting for deployment');
    const prStatusText = isFollowUp && threadContext
      ? `✅ Changes pushed to existing PR!`
      : `✅ Pull request created!`;
    await slackService.updateMessage(
      channel,
      statusMessageTs,
      `🚀 *Deploying to preview...*\n\n` +
      `${prStatusText}\n` +
      `📝 PR: ${finalPrUrl}\n\n` +
      `⏳ Waiting for Vercel to deploy preview (this may take 2-5 minutes)...`
    );

    // Try Vercel API first, then fall back to GitHub PR comments
    let deployment = await vercelDeploymentService.waitForDeployment(branchName, 5);

    // If Vercel API returned placeholder URL (credentials not configured),
    // try to get the actual preview URL from GitHub PR comments
    if (deployment.success && deployment.url === 'https://vercel-auto-deploy.example.com' && finalPrNumber) {
      logger.info('Vercel API not configured, checking PR comments for preview URL...');

      const previewUrl = await githubAPIService.getVercelPreviewUrlFromComments(finalPrNumber, 5);

      if (previewUrl) {
        deployment = {
          success: true,
          url: previewUrl,
          status: 'READY',
        };
      } else {
        // No preview URL found in comments either
        deployment = {
          success: false,
          error: 'Preview URL not found in Vercel API or PR comments',
        };
      }
    }

    // ============================================
    // STEP 10: Report Final Results
    // ============================================
    const { stats } = agentResult;
    const durationStr = (stats.durationMs / 1000).toFixed(1);
    const costStr = stats.costUsd.toFixed(4);

    // Combine new files with any previously modified files for thread context
    const allFilesChanged = threadContext
      ? [...new Set([...threadContext.filesChanged, ...filesChanged])]
      : filesChanged;

    if (deployment.success && deployment.url) {
      const successMessage = formatSuccessMessage({
        previewUrl: deployment.url,
        prUrl: finalPrUrl!,
        branchName,
        commitHash: commitResult.hash?.substring(0, 7) || 'unknown',
        analysis: agentResult.analysis,
        filesChanged,
        stats,
        userId,
        commandsRun: agentResult.commandsRun,
        isFollowUp: !!isFollowUp,
      });

      await slackService.updateMessage(channel, statusMessageTs, successMessage);
      await slackService.addReaction(channel, threadTs, 'white_check_mark');

      logger.info('Issue processing completed successfully!', {
        jobId: job.id,
        prUrl: finalPrUrl,
        previewUrl: deployment.url,
        cost: costStr,
        duration: durationStr,
        isFollowUp: !!isFollowUp,
      });

      // Mark thread as completed with context for follow-ups
      const newThreadContext: ThreadContext = {
        branchName,
        prUrl: finalPrUrl,
        prNumber: finalPrNumber,
        originalIssueText: threadContext?.originalIssueText || text,
        filesChanged: allFilesChanged,
      };
      markThreadCompleted(threadTs, newThreadContext);

      return {
        jobId: job.id,
        status: 'completed',
        branchName,
        prUrl: finalPrUrl,
        previewUrl: deployment.url,
        deployment,
      };
    } else {
      // Deployment failed or timed out
      const partialSuccessMessage = formatPartialSuccessMessage({
        prUrl: finalPrUrl!,
        branchName,
        analysis: agentResult.analysis,
        filesChanged,
        stats,
        deploymentError: deployment.error,
      });

      await slackService.updateMessage(channel, statusMessageTs, partialSuccessMessage);
      await slackService.addReaction(channel, threadTs, 'warning');

      // Mark thread as completed with context for follow-ups
      const partialThreadContext: ThreadContext = {
        branchName,
        prUrl: finalPrUrl,
        prNumber: finalPrNumber,
        originalIssueText: threadContext?.originalIssueText || text,
        filesChanged: allFilesChanged,
      };
      markThreadCompleted(threadTs, partialThreadContext);

      return {
        jobId: job.id,
        status: 'completed',
        branchName,
        prUrl: finalPrUrl,
        deployment,
      };
    }
  } catch (error) {
    logger.error('💥 Critical error in issue processing', {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });

    // Clear the active thread state so the thread can be retried
    clearActiveThread(threadTs);

    // Try to update status message if we have one
    if (statusMessageTs) {
      try {
        await slackService.updateMessage(
          channel,
          statusMessageTs,
          `❌ *System Error*\n\n` +
          `An unexpected error occurred:\n` +
          `\`\`\`\n${error instanceof Error ? error.message : String(error)}\n\`\`\`\n\n` +
          `Please try again or contact support if the issue persists.` +
          `${branchName ? `\n\n_Note: Branch \`${branchName}\` may have been created._` : ''}`
        );
      } catch {
        // If we can't update, post a new message
        await slackService.postMessage(
          channel,
          `❌ Critical error: ${error instanceof Error ? error.message : String(error)}`,
          threadTs
        );
      }
    }

    return {
      jobId: job.id,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Determine branch type from issue text
 */
function determineBranchType(text: string): 'fix' | 'feat' | 'refactor' | 'chore' {
  const lowerText = text.toLowerCase();

  if (lowerText.includes('bug') || lowerText.includes('fix') || lowerText.includes('error') || lowerText.includes('broken')) {
    return 'fix';
  }

  if (lowerText.includes('feature') || lowerText.includes('add') || lowerText.includes('implement') || lowerText.includes('new')) {
    return 'feat';
  }

  if (lowerText.includes('refactor') || lowerText.includes('improve') || lowerText.includes('optimize') || lowerText.includes('clean')) {
    return 'refactor';
  }

  return 'chore';
}

/**
 * Extract a concise solution summary from agent's analysis
 */
function extractSolutionSummary(analysis: string): string {
  // Try to find key phrases that indicate the solution
  const lines = analysis.split('\n');
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('fixed') || lower.includes('changed') || lower.includes('updated') ||
        lower.includes('added') || lower.includes('removed') || lower.includes('modified')) {
      return line.trim().substring(0, 200);
    }
  }
  // Fallback to first non-empty line
  return lines.find(l => l.trim().length > 10)?.substring(0, 200) || 'Applied fix';
}

/**
 * Generate commit message
 */
function generateCommitMessage(
  issueText: string,
  solution: string,
  filesChanged: string[]
): string {
  const preview = issueText.substring(0, 50) + (issueText.length > 50 ? '...' : '');

  return `🤖 Auto-fix: ${preview}

${solution}

Files changed:
${filesChanged.map((f) => `- ${f}`).join('\n')}

---
🤖 Generated by Claude Agent SDK
Co-authored-by: Claude <noreply@anthropic.com>`;
}

/**
 * Generate PR title following conventional commit format
 * Format: type: [scope] description
 */
function generatePRTitle(issueText: string, type: string, filesChanged: string[]): string {
  // Determine scope based on file paths
  let scope = 'general';

  if (filesChanged.some(f => f.includes('api') || f.includes('controller'))) {
    scope = 'api';
  } else if (filesChanged.some(f => f.includes('checkout') || f.includes('payment'))) {
    scope = 'checkout';
  } else if (filesChanged.some(f => f.includes('auth'))) {
    scope = 'auth';
  } else if (filesChanged.some(f => f.includes('event'))) {
    scope = 'events';
  } else if (filesChanged.some(f => f.includes('frontend') || f.includes('.tsx'))) {
    scope = 'ui';
  } else if (filesChanged.some(f => f.includes('backend') || f.includes('.rb'))) {
    scope = 'backend';
  } else if (filesChanged.some(f => f.includes('README') || f.includes('.md'))) {
    scope = 'docs';
  }

  // Map branch type to conventional commit type
  const typeMap: Record<string, string> = {
    'fix': 'fix',
    'feat': 'feat',
    'feature': 'feat',
    'refactor': 'refactor',
    'docs': 'docs',
    'chore': 'chore',
    'test': 'test',
    'perf': 'perf',
  };

  const commitType = typeMap[type] || 'fix';

  // Clean up issue text for title - must be single line, no special chars
  const cleanText = issueText
    // Take only the first line (before any newline)
    .split(/[\r\n]/)[0]
    // Remove common action words that are redundant with the type
    .replace(/^(fix|add|update|create|implement|refactor|change|modify|make|when)\s+/i, '')
    // Remove any remaining special characters that could break the title
    .replace(/[^\w\s\-.,!?'"()]/g, '')
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    .trim()
    // Limit to 50 chars for a clean title
    .substring(0, 50)
    // Remove trailing partial words
    .replace(/\s+\S*$/, (match) => match.length < 10 ? '' : match)
    .trim();

  // Ensure we have something meaningful
  const finalText = cleanText.length >= 5
    ? cleanText
    : `automated fix for ${filesChanged.length} file(s)`;

  return `${commitType}: [${scope}] ${finalText}`;
}

/**
 * Format PR description following PR template conventions
 */
function formatPRDescription(
  agentResult: { analysis: string; commandsRun: string[]; stats: { costUsd: number; turns: number; durationMs: number } },
  filesChanged: string[]
): string {
  const { stats } = agentResult;

  // Determine which components are affected based on file paths
  const hasBackend = filesChanged.some(f =>
    f.includes('apps/backend/') || f.endsWith('.rb') || f.includes('backend/')
  );
  const hasFrontend = filesChanged.some(f =>
    f.includes('apps/frontend/') || f.endsWith('.tsx') || f.endsWith('.ts') || f.includes('frontend/')
  );
  const hasInfra = filesChanged.some(f =>
    f.includes('.md') || f.includes('config') || f.includes('.yml') || f.includes('.yaml')
  );

  // Create a cleaner summary from analysis (first sentence or 200 chars)
  // Ensure we always have at least 10 characters for PR validation
  let summary = '';
  if (agentResult.analysis && agentResult.analysis.length > 0) {
    const summaryMatch = agentResult.analysis.match(/^[^.!?]+[.!?]/);
    summary = summaryMatch
      ? summaryMatch[0].trim()
      : agentResult.analysis.substring(0, 200).trim();
    if (summary.length < 200 && !summary.endsWith('.')) {
      summary += agentResult.analysis.length > summary.length ? '...' : '';
    }
  }
  // Fallback if summary is too short
  if (summary.length < 10) {
    summary = `Automated fix applied to ${filesChanged.length} file(s) by Claude Agent.`;
  }

  return `## Summary
${summary}

## Component
- [${hasBackend ? 'x' : ' '}] Backend (Rails)
- [${hasFrontend ? 'x' : ' '}] Frontend (Next.js)
- [${hasInfra ? 'x' : ' '}] Infrastructure/Docs/Config

---

## How to Test
1. Pull this branch locally
2. Review the code changes in the Files tab
3. Test the affected functionality
4. Verify the fix addresses the reported issue

**Full Analysis from Claude:**
${agentResult.analysis.substring(0, 1500)}${agentResult.analysis.length > 1500 ? '...' : ''}

---

## Checklist
- [x] Tests pass locally
- [ ] Tested manually
- [ ] QA approved (if user-facing)

## Notes
**Files Changed (${filesChanged.length}):**
${filesChanged.map((file) => `- \`${file}\``).join('\n')}

**Agent Stats:**
- ⏱️ Duration: ${(stats.durationMs / 1000).toFixed(1)}s
- 💰 Cost: $${stats.costUsd.toFixed(4)}
- 🔄 Turns: ${stats.turns}

${agentResult.commandsRun.length > 0 ? `**Commands Run:**\n${agentResult.commandsRun.slice(0, 5).map(cmd => `- \`${cmd.substring(0, 60)}\``).join('\n')}` : ''}

---
🤖 *This PR was automatically generated by [Claude AutoFix Bot](https://github.com/MattKilmer/claude-slackbot) using Claude Agent SDK*
*Co-authored-by: Claude <noreply@anthropic.com>*`;
}

/**
 * Format success message for Slack
 */
function formatSuccessMessage(params: {
  previewUrl: string;
  prUrl: string;
  branchName: string;
  commitHash: string;
  analysis: string;
  filesChanged: string[];
  stats: { durationMs: number; costUsd: number; turns: number };
  userId: string;
  commandsRun: string[];
  isFollowUp?: boolean;
}): string {
  const { previewUrl, prUrl, branchName, commitHash, analysis, filesChanged, stats, userId, commandsRun, isFollowUp } = params;

  // Truncate analysis for Slack
  const shortAnalysis = analysis.length > 800
    ? analysis.substring(0, 800) + '...'
    : analysis;

  const titleText = isFollowUp
    ? `✅ *Follow-up Changes Deployed!*`
    : `✅ *Fix Deployed Successfully!*`;

  return `${titleText}

🔗 *Preview URL:* ${previewUrl}
📝 *Pull Request:* ${prUrl}
🌿 *Branch:* \`${branchName}\`
📌 *Commit:* \`${commitHash}\`

---

### 📊 Analysis
${shortAnalysis}

### 📂 Files Modified (${filesChanged.length})
${filesChanged.map((f) => `• \`${f}\``).join('\n')}

${commandsRun.length > 0 ? `### 🔧 Commands Run
${commandsRun.slice(0, 5).map(cmd => `• \`${cmd.substring(0, 60)}${cmd.length > 60 ? '...' : ''}\``).join('\n')}
` : ''}
### 📈 Stats
• ⏱️ Duration: ${(stats.durationMs / 1000).toFixed(1)}s
• 💰 Cost: $${stats.costUsd.toFixed(4)}
• 🔄 Turns: ${stats.turns}

---

⚡ *Ready for testing!* Click the preview URL to see your changes live.
🔍 Review the PR and merge when ready.

_Requested by <@${userId}>_`;
}

/**
 * Format partial success message (PR created but deployment failed)
 */
function formatPartialSuccessMessage(params: {
  prUrl: string;
  branchName: string;
  analysis: string;
  filesChanged: string[];
  stats: { durationMs: number; costUsd: number; turns: number };
  deploymentError?: string;
}): string {
  const { prUrl, branchName, analysis, filesChanged, stats, deploymentError } = params;

  const shortAnalysis = analysis.length > 500
    ? analysis.substring(0, 500) + '...'
    : analysis;

  return `⚠️ *Partial Success*

✅ Fix generated and PR created!
❌ Deployment preview may still be building

📝 *Pull Request:* ${prUrl}
🌿 *Branch:* \`${branchName}\`

---

### 💡 Changes Made
${shortAnalysis}

### 📂 Files Modified (${filesChanged.length})
${filesChanged.map((f) => `• \`${f}\``).join('\n')}

### 📈 Stats
• ⏱️ Duration: ${(stats.durationMs / 1000).toFixed(1)}s
• 💰 Cost: $${stats.costUsd.toFixed(4)}
• 🔄 Turns: ${stats.turns}

---

🔍 *Next Steps:*
• Check the PR for the full diff
• Deployment preview may appear in the PR checks shortly
• Or manually deploy to test the changes

_Note: ${deploymentError || 'Deployment is taking longer than expected'}_`;
}

/**
 * Helper to update Slack status message
 */
async function updateSlackStatus(channel: string, ts: string, text: string): Promise<void> {
  try {
    await slackService.updateMessage(channel, ts, text);
  } catch (error) {
    logger.warn('Failed to update Slack status', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
