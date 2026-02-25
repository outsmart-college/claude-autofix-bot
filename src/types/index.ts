import { z } from 'zod';

// ============================================
// SLACK EVENT TYPES
// ============================================

// Schema for Slack file attachments (images, etc.)
export const SlackFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimetype: z.string(),
  filetype: z.string(),
  url_private: z.string(),  // Requires bot token to download
  url_private_download: z.string().optional(),
  thumb_360: z.string().optional(),
  thumb_480: z.string().optional(),
  thumb_720: z.string().optional(),
  thumb_960: z.string().optional(),
  thumb_1024: z.string().optional(),
});

export type SlackFile = z.infer<typeof SlackFileSchema>;

export const SlackEventSchema = z.object({
  type: z.literal('event_callback'),
  team_id: z.string(),
  event: z.object({
    type: z.string(),
    subtype: z.string().optional(),  // 'bot_message', 'message_changed', etc.
    channel: z.string(),
    user: z.string().optional(),     // May be missing for bot messages
    bot_id: z.string().optional(),   // Present when message is from a bot
    text: z.string().optional().default(''),  // May be missing in some events
    ts: z.string(),
    thread_ts: z.string().optional(),
    event_ts: z.string(),
    files: z.array(SlackFileSchema).optional(),  // Image/file attachments
  }),
});

export const SlackVerificationSchema = z.object({
  type: z.literal('url_verification'),
  token: z.string(),
  challenge: z.string(),
});

export type SlackEvent = z.infer<typeof SlackEventSchema>;
export type SlackVerification = z.infer<typeof SlackVerificationSchema>;

// ============================================
// CLAUDE AGENT TYPES
// ============================================

export interface ClaudeAgentConfig {
  systemPrompt: string;
  repoPath: string;
  allowedTools?: string[];
  maxTokens?: number;
}

export interface CodeFix {
  path: string;
  description: string;
  newContent?: string;
  originalContent?: string;
}

export interface FixResult {
  success: boolean;
  analysis: string;
  solution: string;
  filesChanged: string[];
  fixes: CodeFix[];
  error?: string;
}

// ============================================
// GIT & GITHUB TYPES
// ============================================

export interface GitBranchResult {
  success: boolean;
  branchName?: string;
  error?: string;
}

export interface GitCommitResult {
  success: boolean;
  hash?: string;
  branch?: string;
  error?: string;
}

export interface GitHubPRResult {
  success: boolean;
  prNumber?: number;
  prUrl?: string;
  error?: string;
}

// ============================================
// DEPLOYMENT TYPES
// ============================================

export interface DeploymentResult {
  success: boolean;
  url?: string;
  deploymentId?: string;
  status?: 'READY' | 'ERROR' | 'BUILDING' | 'QUEUED' | 'CANCELED';
  error?: string;
}

export interface VercelDeployment {
  id: string;
  url: string;
  readyState: 'READY' | 'ERROR' | 'BUILDING' | 'QUEUED' | 'CANCELED';
  createdAt: number;
  meta?: {
    githubCommitRef?: string;
  };
  projectId?: string;
}

// ============================================
// JOB QUEUE TYPES
// ============================================

// Image attachment info for passing to Claude
export interface ImageAttachment {
  url: string;        // Slack private URL
  filename: string;   // Original filename
  mimetype: string;   // e.g., 'image/png'
}

export interface IssueJob {
  id: string;
  text: string;
  channel: string;
  threadTs: string;
  userId: string;
  timestamp: Date;
  retryCount?: number;
  isFollowUp?: boolean;  // True if this is a follow-up instruction in an existing thread
  prReferences?: PRReferenceInfo[];  // PR references extracted from message
  images?: ImageAttachment[];  // Image attachments (screenshots, etc.)
  threadContext?: ThreadContext;  // Context from previous job in this thread (for follow-ups)
}

// Context stored for completed threads to enable follow-up messages
export interface ThreadContext {
  branchName: string;
  prUrl?: string;
  prNumber?: number;
  originalIssueText: string;  // The original request
  filesChanged: string[];     // Files that were modified
}

export interface PRReferenceInfo {
  owner: string;
  repo: string;
  prNumber: number;
}

export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface JobResult {
  jobId: string;
  status: JobStatus;
  branchName?: string;
  prUrl?: string;
  previewUrl?: string;
  result?: FixResult;
  deployment?: DeploymentResult;
  error?: string;
}

// ============================================
// CONFIG TYPES
// ============================================

export interface Config {
  slack: {
    botToken: string;
    signingSecret: string;
    channelId: string;
    botUserId?: string;
  };
  claude: {
    apiKey: string;
    maxBudgetUsd: number;
    maxTurns: number;
    maxDurationMs: number;
    useAgentSdk: boolean;
    mode: 'sdk' | 'cli';
  };
  github: {
    token: string;
    username: string;
    targetRepoUrl: string;
    baseBranch: string;
    localRepoPath?: string;
  };
  clickup: {
    apiKey: string;
    listId: string;
  };
  deployment: {
    vercelToken?: string;
    vercelProjectId?: string;
    vercelOrgId?: string;
  };
  nodeEnv: 'development' | 'production' | 'test';
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  featureFlags: string[];
}

// ============================================
// AGENT SDK TYPES
// ============================================

/**
 * Progress update from the Agent SDK
 * Used for real-time Slack updates
 */
export interface AgentProgress {
  phase: 'exploring' | 'analyzing' | 'fixing' | 'testing' | 'complete';
  message: string;
  tool?: string;
  detail?: string;
  timestamp: Date;
}

/**
 * Statistics from an Agent SDK run
 */
export interface AgentStats {
  durationMs: number;
  costUsd: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Result from the Agent SDK
 */
export interface AgentResult {
  success: boolean;
  analysis: string;
  filesModified: string[];
  commandsRun: string[];
  stats: AgentStats;
  error?: string;
}

// ============================================
// UTILITY TYPES
// ============================================

export interface LogMetadata {
  [key: string]: any;
}

export type BranchNamingStrategy = 'fix' | 'feat' | 'refactor' | 'chore';

export interface BranchOptions {
  type: BranchNamingStrategy;
  description: string;
  baseBranch?: string;
}
