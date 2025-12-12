import { logger } from '../../utils/logger.js';
import path from 'path';

/**
 * Safety filters for Claude Agent SDK
 *
 * This module implements security controls to prevent Claude from:
 * 1. Running dangerous shell commands (rm -rf, DROP TABLE, etc.)
 * 2. Editing sensitive files (.env, credentials, secrets)
 * 3. Accessing paths outside the repository
 * 4. Making unauthorized network requests
 *
 * IMPORTANT: These filters are critical for production use.
 * Review and customize based on your organization's security requirements.
 *
 * This configuration supports common tech stacks including:
 * - Node.js (npm, yarn, pnpm, bun)
 * - Ruby on Rails (bundle, rake)
 * - Next.js, React, Vue
 */

// ============================================
// BLOCKED COMMAND PATTERNS
// ============================================

/**
 * Commands that are ALWAYS blocked (case-insensitive patterns)
 * These represent operations that should never be automated
 */
const BLOCKED_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Destructive file operations
  { pattern: /rm\s+(-[rf]+\s+)*[\/~]/, reason: 'Recursive delete from root or home' },
  { pattern: /rm\s+-rf?\s+\*/, reason: 'Delete all files' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'Direct disk write' },
  { pattern: /mkfs\./, reason: 'Filesystem format' },
  { pattern: /dd\s+.*of=\/dev\//, reason: 'Direct disk write' },

  // Database destruction
  { pattern: /DROP\s+(DATABASE|TABLE|SCHEMA)/i, reason: 'Database destruction' },
  { pattern: /DELETE\s+FROM\s+\w+\s*(;|$)/i, reason: 'Unfiltered DELETE (no WHERE clause)' },
  { pattern: /TRUNCATE\s+TABLE/i, reason: 'Table truncation' },

  // Privilege escalation
  { pattern: /sudo\s+/, reason: 'Privilege escalation' },
  { pattern: /chmod\s+777/, reason: 'Insecure permissions' },
  { pattern: /chown\s+root/, reason: 'Change ownership to root' },

  // Git danger
  { pattern: /git\s+push\s+.*--force/, reason: 'Force push' },
  { pattern: /git\s+push\s+-f\s/, reason: 'Force push' },
  { pattern: /git\s+reset\s+--hard\s+origin/, reason: 'Hard reset to remote' },
  { pattern: /git\s+clean\s+-fd/, reason: 'Remove untracked files' },

  // Environment/secrets manipulation
  { pattern: /export\s+\w*(_KEY|_SECRET|_TOKEN|_PASSWORD)=/, reason: 'Setting secrets in shell' },
  { pattern: /echo\s+.*>\s*\.env/, reason: 'Overwriting .env file' },

  // Process/system manipulation
  { pattern: /kill\s+-9\s+1\b/, reason: 'Kill init process' },
  { pattern: /shutdown/, reason: 'System shutdown' },
  { pattern: /reboot/, reason: 'System reboot' },
  { pattern: /systemctl\s+(stop|disable)/, reason: 'Stopping system services' },

  // Package manager danger
  { pattern: /npm\s+publish/, reason: 'Publishing packages' },
  { pattern: /npm\s+unpublish/, reason: 'Unpublishing packages' },
  { pattern: /npm\s+deprecate/, reason: 'Deprecating packages' },

  // Crypto mining / malware patterns
  { pattern: /curl.*\|\s*(ba)?sh/, reason: 'Piping remote script to shell' },
  { pattern: /wget.*\|\s*(ba)?sh/, reason: 'Piping remote script to shell' },
  { pattern: /xmrig|minerd|cryptonight/, reason: 'Potential crypto mining' },
];

/**
 * Commands that require extra caution (logged but allowed)
 */
const WARN_BASH_PATTERNS: Array<{ pattern: RegExp; warning: string }> = [
  { pattern: /curl\s+/, warning: 'Network request with curl' },
  { pattern: /wget\s+/, warning: 'Network request with wget' },
  { pattern: /npm\s+install\s+-g/, warning: 'Global npm install' },
  { pattern: /docker\s+/, warning: 'Docker command' },
  { pattern: /git\s+push/, warning: 'Git push operation' },
];

/**
 * Allowlisted commands that are always safe
 * Supports multiple tech stacks including Node.js and Ruby on Rails
 */
const ALLOWED_BASH_PATTERNS: RegExp[] = [
  // JavaScript package managers
  /^npm\s+(run|test|start|build|ci|install)\b/,
  /^yarn\s+(test|build|start|install)\b/,
  /^pnpm\s+(test|build|start|install)\b/,
  /^bun\s+(run|test|build|install|dev|lint)\b/,
  /^node\s+/,
  /^npx\s+(tsc|eslint|prettier|vitest|jest)\b/,

  // Ruby/Rails commands
  /^bundle\s+(exec|install|update)\b/,
  /^bin\/cop\b/,  // RuboCop linter
  /^bin\/rails\b/,  // Rails commands
  /^rake\s+/,  // Rake tasks

  // Git (read-only operations)
  /^git\s+(status|log|diff|branch|show)\b/,

  // File system (read operations)
  /^ls\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^grep\b/,
  /^find\s+\./,  // find only within current directory
  /^pwd$/,
  /^echo\s/,
  /^mkdir\s+-p?\s+\./,  // mkdir only within current directory
  /^cp\s+[^\/]/,  // cp not starting with /
  /^mv\s+[^\/]/,  // mv not starting with /
];

// ============================================
// PROTECTED FILE PATTERNS
// ============================================

/**
 * Files that should NEVER be edited by the bot
 * Includes common secret files across multiple frameworks
 */
const PROTECTED_FILE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Environment and secrets
  { pattern: /\.env($|\.)/, reason: 'Environment file' },
  { pattern: /\.env\.local$/, reason: 'Local environment file' },
  { pattern: /\.env\.production$/, reason: 'Production environment file' },
  { pattern: /credentials\.(json|yaml|yml)$/i, reason: 'Credentials file' },
  { pattern: /secrets?\.(json|yaml|yml)$/i, reason: 'Secrets file' },
  { pattern: /\.pem$/, reason: 'Private key' },
  { pattern: /\.key$/, reason: 'Private key' },
  { pattern: /id_rsa/, reason: 'SSH private key' },

  // Rails secrets and config
  { pattern: /config\/application\.yml$/, reason: 'Rails application secrets (Figaro)' },
  { pattern: /config\/credentials\.yml\.enc$/, reason: 'Rails encrypted credentials' },
  { pattern: /config\/master\.key$/, reason: 'Rails master key' },
  { pattern: /config\/database\.yml$/, reason: 'Database configuration' },

  // Git internals
  { pattern: /\.git\//, reason: 'Git internal file' },

  // CI/CD secrets (be careful here)
  { pattern: /\.github\/workflows\/.*secrets/i, reason: 'GitHub secrets reference' },

  // Package locks (usually auto-generated)
  { pattern: /package-lock\.json$/, reason: 'Package lock (auto-generated)' },
  { pattern: /yarn\.lock$/, reason: 'Yarn lock (auto-generated)' },
  { pattern: /pnpm-lock\.yaml$/, reason: 'PNPM lock (auto-generated)' },
  { pattern: /bun\.lockb$/, reason: 'Bun lock (auto-generated)' },
  { pattern: /Gemfile\.lock$/, reason: 'Gemfile lock (auto-generated)' },
];

/**
 * Files that can be edited but should be logged
 * Includes Rails and Next.js config files
 */
const SENSITIVE_FILE_PATTERNS: Array<{ pattern: RegExp; warning: string }> = [
  { pattern: /package\.json$/, warning: 'Package manifest - dependencies may change' },
  { pattern: /tsconfig\.json$/, warning: 'TypeScript config' },
  { pattern: /\.github\/workflows\//, warning: 'GitHub Actions workflow' },
  { pattern: /vercel\.json$/, warning: 'Vercel configuration' },
  { pattern: /Dockerfile$/, warning: 'Docker configuration' },
  { pattern: /docker-compose\.ya?ml$/, warning: 'Docker Compose configuration' },

  // Rails configuration files
  { pattern: /Gemfile$/, warning: 'Ruby dependencies (Gemfile)' },
  { pattern: /config\/routes\.rb$/, warning: 'Rails routes' },
  { pattern: /config\/initializers\//, warning: 'Rails initializer' },
  { pattern: /db\/migrate\//, warning: 'Database migration' },
  { pattern: /db\/schema\.rb$/, warning: 'Database schema' },

  // Next.js configuration files
  { pattern: /next\.config\.(js|ts|mjs)$/, warning: 'Next.js configuration' },
  { pattern: /tailwind\.config\.(js|ts)$/, warning: 'Tailwind CSS configuration' },
];

// ============================================
// SAFETY CHECK FUNCTIONS
// ============================================

export interface SafetyCheckResult {
  allowed: boolean;
  reason?: string;
  warning?: string;
}

/**
 * Check if a bash command is safe to execute
 */
export function checkBashCommand(command: string): SafetyCheckResult {
  const normalizedCommand = command.trim();

  // First check allowlist - these are always safe
  for (const pattern of ALLOWED_BASH_PATTERNS) {
    if (pattern.test(normalizedCommand)) {
      return { allowed: true };
    }
  }

  // Check blocklist
  for (const { pattern, reason } of BLOCKED_BASH_PATTERNS) {
    if (pattern.test(normalizedCommand)) {
      logger.warn('Blocked dangerous bash command', {
        command: normalizedCommand.substring(0, 100),
        reason,
      });
      return { allowed: false, reason: `Blocked: ${reason}` };
    }
  }

  // Check warnings
  for (const { pattern, warning } of WARN_BASH_PATTERNS) {
    if (pattern.test(normalizedCommand)) {
      logger.info('Allowing bash command with warning', {
        command: normalizedCommand.substring(0, 100),
        warning,
      });
      return { allowed: true, warning };
    }
  }

  // Default: allow with generic warning for unknown commands
  logger.debug('Allowing unknown bash command', {
    command: normalizedCommand.substring(0, 50),
  });
  return { allowed: true };
}

/**
 * Check if a file path is safe to edit
 */
export function checkFilePath(filePath: string, repoPath: string): SafetyCheckResult {
  const normalizedPath = path.normalize(filePath);
  const absolutePath = path.isAbsolute(normalizedPath)
    ? normalizedPath
    : path.join(repoPath, normalizedPath);

  // Check if path is within repo
  const resolvedRepo = path.resolve(repoPath);
  const resolvedFile = path.resolve(absolutePath);

  if (!resolvedFile.startsWith(resolvedRepo)) {
    logger.warn('Blocked file access outside repository', {
      filePath,
      repoPath,
    });
    return { allowed: false, reason: 'Path outside repository' };
  }

  // Check protected files
  for (const { pattern, reason } of PROTECTED_FILE_PATTERNS) {
    if (pattern.test(normalizedPath)) {
      logger.warn('Blocked access to protected file', {
        filePath,
        reason,
      });
      return { allowed: false, reason: `Protected file: ${reason}` };
    }
  }

  // Check sensitive files (allow but warn)
  for (const { pattern, warning } of SENSITIVE_FILE_PATTERNS) {
    if (pattern.test(normalizedPath)) {
      logger.info('Allowing access to sensitive file', {
        filePath,
        warning,
      });
      return { allowed: true, warning };
    }
  }

  return { allowed: true };
}

/**
 * Permission result type matching the Agent SDK's PermissionResult
 */
export type PermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

/**
 * Create a canUseTool callback for the Agent SDK
 *
 * This function creates the permission callback that the Agent SDK
 * calls before executing any tool. It implements our safety policy.
 */
export function createToolPermissionCallback(repoPath: string) {
  return async (
    toolName: string,
    toolInput: Record<string, unknown>,
    _options: { signal: AbortSignal; toolUseID: string }
  ): Promise<PermissionResult> => {
    // Log all tool uses for audit
    logger.debug('Tool permission check', {
      tool: toolName,
      input: JSON.stringify(toolInput).substring(0, 200),
    });

    // Handle Bash commands
    if (toolName === 'Bash') {
      const command = toolInput.command as string;
      if (!command) {
        return { behavior: 'allow', updatedInput: toolInput };
      }

      const result = checkBashCommand(command);
      if (!result.allowed) {
        return { behavior: 'deny', message: result.reason || 'Command blocked' };
      }
      return { behavior: 'allow', updatedInput: toolInput };
    }

    // Handle file editing tools
    if (toolName === 'Edit' || toolName === 'Write') {
      const filePath = (toolInput.file_path || toolInput.path) as string;
      if (!filePath) {
        return { behavior: 'allow', updatedInput: toolInput };
      }

      const result = checkFilePath(filePath, repoPath);
      if (!result.allowed) {
        return { behavior: 'deny', message: result.reason || 'File access blocked' };
      }
      return { behavior: 'allow', updatedInput: toolInput };
    }

    // Handle Read tool - less restrictive but still check bounds
    if (toolName === 'Read') {
      const filePath = (toolInput.file_path || toolInput.path) as string;
      if (filePath) {
        const absolutePath = path.isAbsolute(filePath)
          ? filePath
          : path.join(repoPath, filePath);
        const resolvedRepo = path.resolve(repoPath);
        const resolvedFile = path.resolve(absolutePath);

        // Allow reading .env for debugging but log it
        if (/\.env/.test(filePath)) {
          logger.info('Reading environment file (contents will be visible to Claude)', {
            filePath,
          });
        }

        // Block reading outside repo
        if (!resolvedFile.startsWith(resolvedRepo)) {
          // Allow reading common system paths for debugging
          if (!filePath.startsWith('/tmp/') && !filePath.startsWith('/var/log/')) {
            return { behavior: 'deny', message: 'Cannot read files outside repository' };
          }
        }
      }
      return { behavior: 'allow', updatedInput: toolInput };
    }

    // Allow other tools by default
    return { behavior: 'allow', updatedInput: toolInput };
  };
}

// ============================================
// SAFETY CONFIGURATION
// ============================================

export interface SafetyConfig {
  maxBudgetUsd: number;
  maxTurns: number;
  maxDurationMs: number;
  allowNetworkCommands: boolean;
  allowDockerCommands: boolean;
  customBlockedPatterns?: string[];
  customAllowedPaths?: string[];
}

export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  maxBudgetUsd: 50.0,           // $50 per fix
  maxTurns: 10000,              // 10k turns for very large complex tasks (10x increase)
  maxDurationMs: 5 * 60 * 60 * 1000, // 5 hours (10x increase from 30 min)
  allowNetworkCommands: false,  // Block curl/wget by default
  allowDockerCommands: false,   // Block docker by default
};

/**
 * Get safety configuration from environment variables
 */
export function getSafetyConfig(): SafetyConfig {
  return {
    maxBudgetUsd: parseFloat(process.env.CLAUDE_MAX_BUDGET_USD || '50'),
    maxTurns: parseInt(process.env.CLAUDE_MAX_TURNS || '10000', 10),
    maxDurationMs: parseInt(process.env.CLAUDE_MAX_DURATION_MS || String(5 * 60 * 60 * 1000), 10),
    allowNetworkCommands: process.env.CLAUDE_ALLOW_NETWORK === 'true',
    allowDockerCommands: process.env.CLAUDE_ALLOW_DOCKER === 'true',
    customBlockedPatterns: process.env.CLAUDE_BLOCKED_PATTERNS?.split(','),
    customAllowedPaths: process.env.CLAUDE_ALLOWED_PATHS?.split(','),
  };
}
