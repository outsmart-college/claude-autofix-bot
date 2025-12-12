import type { VercelRequest, VercelResponse } from '@vercel/node';
import { config } from '../src/config/index.js';

/**
 * Health check endpoint
 *
 * Use this to verify the service is running and properly configured.
 * Returns status of all integrations without exposing sensitive data.
 *
 * Usage:
 *   GET /api/health
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  try {
    // Check if all required services are configured
    const services = {
      slack: {
        configured: !!config.slack.botToken && !!config.slack.signingSecret,
        channelMonitored: !!config.slack.channelId,
      },
      claude: {
        configured: !!config.claude.apiKey,
      },
      github: {
        configured: !!config.github.token && !!config.github.username,
        targetRepo: config.github.targetRepoUrl,
        baseBranch: config.github.baseBranch,
      },
      vercel: {
        configured: !!config.deployment.vercelToken && !!config.deployment.vercelProjectId,
      },
    };

    // Determine overall health status
    const isHealthy =
      services.slack.configured &&
      services.claude.configured &&
      services.github.configured;

    const status = isHealthy ? 'healthy' : 'degraded';
    const statusCode = isHealthy ? 200 : 503;

    res.status(statusCode).json({
      status,
      timestamp: new Date().toISOString(),
      environment: config.nodeEnv,
      version: '1.0.0',
      services,
      featureFlags: config.featureFlags,
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
