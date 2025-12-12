import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { GitBranchResult, GitCommitResult, BranchOptions } from '../../types/index.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * Git automation service for branch creation, commits, and pushes
 *
 * This service handles all Git operations on the target repository:
 * 1. Clone/pull the repository
 * 2. Create feature branches
 * 3. Commit changes with descriptive messages
 * 4. Push to remote (GitHub)
 */
class GitAutomationService {
  private git: SimpleGit | null = null;
  private repoPath: string;
  private targetRepoUrl: string;
  private baseBranch: string;

  constructor() {
    this.targetRepoUrl = config.github.targetRepoUrl;
    this.baseBranch = config.github.baseBranch;

    // Use configured path or create temp directory
    this.repoPath =
      config.github.localRepoPath ||
      path.join(os.tmpdir(), 'claude-autofix-repos', this.getRepoName());
  }

  /**
   * Extract repository name from URL
   */
  private getRepoName(): string {
    const match = this.targetRepoUrl.match(/\/([^\/]+?)(?:\.git)?$/);
    return match ? match[1] : 'repo';
  }

  /**
   * Initialize git client for the repository
   * Clones if doesn't exist, pulls latest if exists
   */
  async initializeRepo(): Promise<void> {
    try {
      logger.info('🔧 Initializing repository', {
        repoUrl: this.targetRepoUrl,
        localPath: this.repoPath,
      });

      // Check if repo already exists locally
      const exists = await this.checkRepoExists();

      if (!exists) {
        // Clone the repository with shallow clone for speed
        // Large monorepos can take forever to clone fully
        logger.info('📦 Cloning repository (shallow)...');
        await fs.mkdir(path.dirname(this.repoPath), { recursive: true });

        // Clone with authentication and shallow depth for speed
        const authUrl = this.getAuthenticatedUrl();
        await simpleGit().clone(authUrl, this.repoPath, [
          '--depth', '1',           // Shallow clone - only latest commit
          '--single-branch',        // Only clone the default branch
          '--no-tags',              // Don't fetch tags
        ]);

        logger.success('Repository cloned successfully (shallow)');
      } else {
        logger.debug('Repository already exists, pulling latest changes');
      }

      // Initialize git client
      const options: Partial<SimpleGitOptions> = {
        baseDir: this.repoPath,
        binary: 'git',
        maxConcurrentProcesses: 1,
      };
      this.git = simpleGit(options);

      // Configure git user identity for commits (required in containerized environments)
      // Use the GitHub username from config for attribution
      const gitEmail = process.env.GIT_USER_EMAIL || `${config.github.username}@users.noreply.github.com`;
      const gitName = process.env.GIT_USER_NAME || config.github.username;
      await this.git.addConfig('user.email', gitEmail);
      await this.git.addConfig('user.name', gitName);
      logger.debug('Git user identity configured', { name: gitName, email: gitEmail });

      // Fetch latest from remote first (shallow fetch for speed)
      // Use --depth 1 to keep it shallow and fast
      await this.git.fetch(['origin', '--depth', '1']);

      // CRITICAL: Reset to a clean state before each job
      // This ensures we don't have leftover changes from previous (failed) runs
      // that could cause the "ahead: 1" issue where git shows no changes
      await this.git.checkout(this.baseBranch);
      await this.git.reset(['--hard', `origin/${this.baseBranch}`]);

      // Also clean any untracked files that might interfere
      await this.git.clean('f', ['-d']);

      logger.success('Repository initialized and reset to clean state');
    } catch (error) {
      logger.error('Failed to initialize repository', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Check if repository exists locally
   */
  private async checkRepoExists(): Promise<boolean> {
    try {
      await fs.access(path.join(this.repoPath, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get authenticated URL for git operations
   */
  private getAuthenticatedUrl(): string {
    const username = config.github.username;
    const token = config.github.token;

    // Convert https://github.com/owner/repo.git
    // to https://username:token@github.com/owner/repo.git
    return this.targetRepoUrl.replace(
      'https://',
      `https://${username}:${token}@`
    );
  }

  /**
   * Create a new branch with a descriptive name
   *
   * Branch naming convention:
   * - fix/description-of-fix
   * - feat/description-of-feature
   * - refactor/description-of-refactor
   */
  async createBranch(options: BranchOptions): Promise<GitBranchResult> {
    if (!this.git) {
      throw new Error('Git not initialized. Call initializeRepo() first.');
    }

    try {
      // Generate branch name
      const branchName = this.generateBranchName(options);

      logger.info('🌿 Creating new branch', { branchName });

      // Ensure we're on base branch first
      await this.git.checkout(options.baseBranch || this.baseBranch);

      // Pull latest changes
      await this.git.pull('origin', options.baseBranch || this.baseBranch);

      // Delete branch if it already exists (cleanup from previous runs)
      try {
        await this.git.deleteLocalBranch(branchName, true);
        logger.debug('Deleted existing local branch', { branchName });
      } catch {
        // Branch doesn't exist - that's fine
      }

      // Create and checkout new branch
      await this.git.checkoutLocalBranch(branchName);

      logger.success('Branch created successfully', { branchName });

      return {
        success: true,
        branchName,
      };
    } catch (error) {
      logger.error('Failed to create branch', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Generate a branch name from description
   * Format: type/concise-description (e.g., feat/add-payment-methods)
   */
  private generateBranchName(options: BranchOptions): string {
    const prefix = options.type;
    // Clean up description: remove common prefixes, lowercase, replace spaces with hyphens
    const sanitized = options.description
      .toLowerCase()
      // Remove common action words that are redundant with the branch type
      .replace(/^(fix|add|update|create|implement|refactor|change|modify|remove|delete)\s+/i, '')
      // Remove "the", "a", "an" articles
      .replace(/\b(the|a|an)\b/g, '')
      // Keep only alphanumeric and spaces/hyphens
      .replace(/[^a-z0-9\s-]/g, '')
      // Collapse multiple spaces/hyphens into single hyphen
      .replace(/[\s-]+/g, '-')
      // Remove leading/trailing hyphens
      .replace(/^-+|-+$/g, '')
      // Max 40 chars for concise branch names
      .substring(0, 40)
      // Clean up trailing partial words
      .replace(/-[^-]*$/, (match) => match.length < 4 ? '' : match);

    return `${prefix}/${sanitized}`;
  }

  /**
   * Commit changes with a descriptive message
   */
  async commitChanges(
    message: string,
    files: string[] = []
  ): Promise<GitCommitResult> {
    if (!this.git) {
      throw new Error('Git not initialized. Call initializeRepo() first.');
    }

    try {
      logger.info('💾 Committing changes', {
        files: files.length,
        messagePreview: message.substring(0, 50),
      });

      // Stage files
      if (files.length > 0) {
        logger.debug('Staging specific files', { count: files.length });
        await this.git.add(files);
      } else {
        logger.debug('Staging all changes');
        await this.git.add('.');
      }

      // Check if there are changes to commit
      const status = await this.git.status();
      if (status.files.length === 0) {
        logger.info('No changes to commit');
        const current = await this.getCurrentBranch();
        return {
          success: true,
          branch: current,
        };
      }

      // Commit
      const commitResult = await this.git.commit(message);
      const hash = commitResult.commit;

      logger.success('Changes committed', {
        hash: hash.substring(0, 7),
        files: status.files.length,
      });

      return {
        success: true,
        hash,
        branch: await this.getCurrentBranch(),
      };
    } catch (error) {
      logger.error('Failed to commit changes', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Push branch to remote
   */
  async pushBranch(branchName: string): Promise<boolean> {
    if (!this.git) {
      throw new Error('Git not initialized. Call initializeRepo() first.');
    }

    try {
      logger.info('📤 Pushing branch to remote', { branchName });

      // Update remote URL with current credentials before push
      // This ensures we use the latest token from environment
      const authUrl = this.getAuthenticatedUrl();
      await this.git.remote(['set-url', 'origin', authUrl]);
      logger.debug('Remote URL updated with credentials');

      // Push with upstream tracking and force flag
      // Force is needed because the branch may already exist from a previous (failed) run
      // with different commits, causing "tip of your current branch is behind" errors
      await this.git.push(['--set-upstream', '--force', 'origin', branchName]);

      logger.success('Branch pushed successfully', { branchName });

      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Log each field separately so Railway doesn't truncate
      logger.error('❌ GIT PUSH FAILED ❌');
      logger.error('Error message: ' + errorMessage);
      logger.error('Branch: ' + branchName);
      logger.error('Repo path: ' + this.repoPath);
      logger.error('Target URL: ' + this.targetRepoUrl);
      logger.error('Username: ' + config.github.username);
      logger.error('Token prefix: ' + (config.github.token?.substring(0, 10) || 'MISSING') + '...');
      return false;
    }
  }

  /**
   * Get current branch name
   */
  async getCurrentBranch(): Promise<string> {
    if (!this.git) {
      throw new Error('Git not initialized. Call initializeRepo() first.');
    }

    const status = await this.git.status();
    return status.current || 'unknown';
  }

  /**
   * Checkout an existing branch (for follow-up work)
   * This fetches the branch from remote and checks it out locally
   */
  async checkoutExistingBranch(branchName: string): Promise<GitBranchResult> {
    if (!this.git) {
      throw new Error('Git not initialized. Call initializeRepo() first.');
    }

    try {
      logger.info('🌿 Checking out existing branch', { branchName });

      // Fetch the branch from remote
      await this.git.fetch(['origin', branchName, '--depth', '1']);

      // Try to checkout the branch - first try local, then from remote
      try {
        await this.git.checkout(branchName);
      } catch {
        // Branch doesn't exist locally, create it from remote
        await this.git.checkout(['-b', branchName, `origin/${branchName}`]);
      }

      // Pull latest changes to ensure we're up to date
      await this.git.pull('origin', branchName);

      logger.success('Branch checked out successfully', { branchName });

      return {
        success: true,
        branchName,
      };
    } catch (error) {
      logger.error('Failed to checkout existing branch', {
        branchName,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get repository path
   */
  getRepoPath(): string {
    return this.repoPath;
  }

  /**
   * Get repository status
   */
  async getStatus() {
    if (!this.git) {
      throw new Error('Git not initialized. Call initializeRepo() first.');
    }
    return this.git.status();
  }
}

// Export singleton instance
export const gitAutomationService = new GitAutomationService();
