import { Octokit } from '@octokit/rest';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { GitBranchResult, GitCommitResult, BranchOptions } from '../../types/index.js';

/**
 * GitHub-based Git service that works in serverless environments
 *
 * This service replaces the simple-git based automation service,
 * using only the GitHub REST API which doesn't require the git CLI.
 *
 * Operations:
 * - Read repository files via API
 * - Create branches via API
 * - Create/update files via API
 * - Push commits via API
 */
class GitHubGitService {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private baseBranch: string;

  constructor() {
    this.octokit = new Octokit({
      auth: config.github.token,
    });

    // Parse owner/repo from URL
    // https://github.com/your-org/your-repo.git -> owner: your-org, repo: your-repo
    const match = config.github.targetRepoUrl.match(/github\.com\/([^\/]+)\/([^\/\.]+)/);
    if (!match) {
      throw new Error(`Invalid GitHub URL: ${config.github.targetRepoUrl}`);
    }
    this.owner = match[1];
    this.repo = match[2];
    this.baseBranch = config.github.baseBranch;

    logger.info('GitHubGitService initialized', {
      owner: this.owner,
      repo: this.repo,
      baseBranch: this.baseBranch,
    });
  }

  /**
   * Initialize (no-op for API-based service, but maintains interface)
   */
  async initializeRepo(): Promise<void> {
    // Verify access to the repository
    try {
      await this.octokit.repos.get({
        owner: this.owner,
        repo: this.repo,
      });
      logger.success('Repository access verified', {
        repo: `${this.owner}/${this.repo}`,
      });
    } catch (error) {
      logger.error('Failed to access repository', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get the SHA of a branch (needed for creating new branches)
   */
  private async getBranchSha(branchName: string): Promise<string> {
    const { data } = await this.octokit.git.getRef({
      owner: this.owner,
      repo: this.repo,
      ref: `heads/${branchName}`,
    });
    return data.object.sha;
  }

  /**
   * Create a new branch
   */
  async createBranch(options: BranchOptions): Promise<GitBranchResult> {
    try {
      const branchName = this.generateBranchName(options);
      const baseBranch = options.baseBranch || this.baseBranch;

      logger.info('Creating branch via GitHub API', {
        branchName,
        baseBranch,
      });

      // Get the SHA of the base branch
      const baseSha = await this.getBranchSha(baseBranch);

      // Try to delete existing branch first (cleanup)
      try {
        await this.octokit.git.deleteRef({
          owner: this.owner,
          repo: this.repo,
          ref: `heads/${branchName}`,
        });
        logger.debug('Deleted existing branch', { branchName });
      } catch {
        // Branch doesn't exist - that's fine
      }

      // Create the new branch
      await this.octokit.git.createRef({
        owner: this.owner,
        repo: this.repo,
        ref: `refs/heads/${branchName}`,
        sha: baseSha,
      });

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
   */
  private generateBranchName(options: BranchOptions): string {
    const prefix = options.type;
    const sanitized = options.description
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50);
    return `${prefix}/${sanitized}`;
  }

  /**
   * Read a file from the repository
   */
  async readFile(filePath: string, branch?: string): Promise<{ content: string; sha: string } | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: filePath,
        ref: branch || this.baseBranch,
      });

      if ('content' in data && typeof data.content === 'string') {
        return {
          content: Buffer.from(data.content, 'base64').toString('utf-8'),
          sha: data.sha,
        };
      }
      return null;
    } catch (error) {
      if ((error as any).status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Create or update a file in the repository
   */
  async createOrUpdateFile(
    filePath: string,
    content: string,
    message: string,
    branch: string
  ): Promise<{ sha: string; success: boolean }> {
    try {
      // Check if file exists to get its SHA
      let existingSha: string | undefined;
      try {
        const existing = await this.readFile(filePath, branch);
        if (existing) {
          existingSha = existing.sha;
        }
      } catch {
        // File doesn't exist - that's fine for new files
      }

      const { data } = await this.octokit.repos.createOrUpdateFileContents({
        owner: this.owner,
        repo: this.repo,
        path: filePath,
        message,
        content: Buffer.from(content).toString('base64'),
        branch,
        sha: existingSha,
        committer: {
          name: 'Claude AutoFix Bot',
          email: 'noreply@anthropic.com',
        },
        author: {
          name: 'Claude AutoFix Bot',
          email: 'noreply@anthropic.com',
        },
      });

      return {
        sha: data.commit.sha || '',
        success: true,
      };
    } catch (error) {
      logger.error('Failed to create/update file', {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        sha: '',
        success: false,
      };
    }
  }

  /**
   * Commit multiple file changes at once using Git Trees API
   * This is more efficient than individual file commits
   */
  async commitChanges(
    branch: string,
    files: Array<{ path: string; content: string }>,
    message: string
  ): Promise<GitCommitResult> {
    try {
      if (files.length === 0) {
        logger.info('No files to commit');
        return {
          success: true,
          branch,
        };
      }

      logger.info('Committing changes via GitHub API', {
        branch,
        fileCount: files.length,
      });

      // Get the current commit SHA and tree SHA for the branch
      const { data: refData } = await this.octokit.git.getRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${branch}`,
      });
      const currentCommitSha = refData.object.sha;

      const { data: commitData } = await this.octokit.git.getCommit({
        owner: this.owner,
        repo: this.repo,
        commit_sha: currentCommitSha,
      });
      const baseTreeSha = commitData.tree.sha;

      // Create blobs for each file
      const blobs = await Promise.all(
        files.map(async (file) => {
          const { data: blobData } = await this.octokit.git.createBlob({
            owner: this.owner,
            repo: this.repo,
            content: Buffer.from(file.content).toString('base64'),
            encoding: 'base64',
          });
          return {
            path: file.path,
            sha: blobData.sha,
          };
        })
      );

      // Create a new tree with all the file changes
      const { data: treeData } = await this.octokit.git.createTree({
        owner: this.owner,
        repo: this.repo,
        base_tree: baseTreeSha,
        tree: blobs.map((blob) => ({
          path: blob.path,
          mode: '100644' as const,
          type: 'blob' as const,
          sha: blob.sha,
        })),
      });

      // Create the commit
      const fullMessage = `${message}\n\n🤖 Generated by Claude AutoFix Bot\nCo-authored-by: Claude <noreply@anthropic.com>`;

      const { data: newCommit } = await this.octokit.git.createCommit({
        owner: this.owner,
        repo: this.repo,
        message: fullMessage,
        tree: treeData.sha,
        parents: [currentCommitSha],
        author: {
          name: 'Claude AutoFix Bot',
          email: 'noreply@anthropic.com',
          date: new Date().toISOString(),
        },
        committer: {
          name: 'Claude AutoFix Bot',
          email: 'noreply@anthropic.com',
          date: new Date().toISOString(),
        },
      });

      // Update the branch reference to point to the new commit
      await this.octokit.git.updateRef({
        owner: this.owner,
        repo: this.repo,
        ref: `heads/${branch}`,
        sha: newCommit.sha,
      });

      logger.success('Changes committed successfully', {
        hash: newCommit.sha.substring(0, 7),
        files: files.length,
      });

      return {
        success: true,
        hash: newCommit.sha,
        branch,
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
   * Get directory contents
   */
  async listDirectory(dirPath: string = '', branch?: string): Promise<string[]> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: dirPath,
        ref: branch || this.baseBranch,
      });

      if (Array.isArray(data)) {
        return data.map((item) => item.name);
      }
      return [];
    } catch {
      return [];
    }
  }

  /**
   * Push branch (no-op for API-based service - commits are already pushed)
   */
  async pushBranch(_branchName: string): Promise<boolean> {
    // In API-based flow, commits are already on remote
    return true;
  }

  /**
   * Get current branch (returns base branch as default)
   */
  async getCurrentBranch(): Promise<string> {
    return this.baseBranch;
  }

  /**
   * Get repository path (returns API-based identifier)
   */
  getRepoPath(): string {
    return `github:${this.owner}/${this.repo}`;
  }

  /**
   * Get owner/repo for PR creation
   */
  getRepoInfo(): { owner: string; repo: string; baseBranch: string } {
    return {
      owner: this.owner,
      repo: this.repo,
      baseBranch: this.baseBranch,
    };
  }
}

// Export singleton instance
export const gitHubGitService = new GitHubGitService();
