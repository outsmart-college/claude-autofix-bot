import { z } from 'zod';
import dotenv from 'dotenv';
import { Config } from '../types/index.js';

// Load environment variables from .env.local
dotenv.config({ path: '.env.local' });

// Validation schema with helpful error messages
const ConfigSchema = z.object({
  slack: z.object({
    botToken: z.string().startsWith('xoxb-', {
      message: 'Slack bot token must start with xoxb-. Get it from OAuth & Permissions.',
    }),
    signingSecret: z.string().min(1, {
      message: 'Slack signing secret is required. Get it from Basic Information.',
    }),
    channelId: z.string().startsWith('C', {
      message: 'Slack channel ID must start with C. Right-click channel → View details.',
    }),
    botUserId: z.string().startsWith('U', {
      message: 'Slack bot user ID must start with U. Find it in the bot\'s app profile.',
    }).optional(),
  }),
  claude: z.object({
    apiKey: z.string().startsWith('sk-ant-', {
      message: 'Claude API key must start with sk-ant-. Get it from console.anthropic.com.',
    }),
    // Agent SDK configuration
    maxBudgetUsd: z.number().min(0.1).max(500).default(50.0),  // $50 per fix
    maxTurns: z.number().min(1).max(20000).default(10000),  // 10k turns for very large complex tasks
    maxDurationMs: z.number().min(10000).max(36000000).default(18000000),  // 5 hours default, 10 hours max
    useAgentSdk: z.boolean().default(true),
    // Claude execution mode: 'sdk' (Agent SDK), 'cli' (Claude Code CLI)
    mode: z.enum(['sdk', 'cli']).default('sdk'),
  }),
  github: z.object({
    token: z.string().min(1, {
      message: 'GitHub token is required. Generate at github.com/settings/tokens.',
    }).refine((val) => val.startsWith('ghp_') || val.startsWith('github_pat_') || val.startsWith('gho_'), {
      message: 'GitHub token must start with ghp_, github_pat_, or gho_.',
    }),
    username: z.string().min(1, {
      message: 'GitHub username is required.',
    }),
    targetRepoUrl: z.string().url({
      message: 'Target repo URL must be a valid URL (e.g., https://github.com/owner/repo.git)',
    }),
    baseBranch: z.string().default('main'),
    localRepoPath: z.string().optional(),
  }),
  clickup: z.object({
    apiKey: z.string().default(''),
    listId: z.string().default('901324441486'),
  }),
  deployment: z.object({
    vercelToken: z.string().optional(),
    vercelProjectId: z.string().optional(),
    vercelOrgId: z.string().optional(),
  }),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  featureFlags: z.array(z.string()).default([]),
});

function loadConfig(): Config {
  const rawConfig = {
    slack: {
      botToken: process.env.SLACK_BOT_TOKEN || '',
      signingSecret: process.env.SLACK_SIGNING_SECRET || '',
      channelId: process.env.SLACK_CHANNEL_ID || '',
      botUserId: process.env.SLACK_BOT_USER_ID || 'U0AFL91910Q', // claude-autofix-bot Slack user ID
    },
    claude: {
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      maxBudgetUsd: parseFloat(process.env.CLAUDE_MAX_BUDGET_USD || '50'),
      maxTurns: parseInt(process.env.CLAUDE_MAX_TURNS || '10000', 10),
      maxDurationMs: parseInt(process.env.CLAUDE_MAX_DURATION_MS || '18000000', 10),  // 5 hours default
      useAgentSdk: process.env.USE_AGENT_SDK !== 'false', // Default true
      mode: (process.env.CLAUDE_MODE as any) || 'sdk', // 'sdk' or 'cli'
    },
    github: {
      token: process.env.GITHUB_TOKEN || '',
      username: process.env.GITHUB_USERNAME || '',
      targetRepoUrl: process.env.TARGET_REPO_URL || '',
      baseBranch: process.env.BASE_BRANCH || 'main',
      localRepoPath: process.env.LOCAL_REPO_PATH,
    },
    clickup: {
      apiKey: process.env.CLICKUP_API_KEY || '',
      listId: process.env.CLICKUP_LIST_ID || '901324441486',
    },
    deployment: {
      vercelToken: process.env.VERCEL_TOKEN,
      vercelProjectId: process.env.VERCEL_PROJECT_ID,
      vercelOrgId: process.env.VERCEL_ORG_ID,
    },
    nodeEnv: (process.env.NODE_ENV as any) || 'development',
    logLevel: (process.env.LOG_LEVEL as any) || 'info',
    featureFlags: process.env.FEATURE_FLAGS
      ? process.env.FEATURE_FLAGS.split(',').map((f) => f.trim())
      : [],
  };

  try {
    return ConfigSchema.parse(rawConfig);
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('\n❌ Configuration validation failed:\n');
      error.errors.forEach((err) => {
        console.error(`  ❌ ${err.path.join('.')}: ${err.message}`);
      });
      console.error('\n💡 Check your .env.local file and ensure all required variables are set.\n');
      throw new Error('Invalid configuration. See errors above.');
    }
    throw error;
  }
}

// Export singleton config instance
export const config = loadConfig();

// Helper to check if a feature flag is enabled
export function isFeatureEnabled(flag: string): boolean {
  return config.featureFlags.includes(flag);
}
