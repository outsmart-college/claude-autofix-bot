import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { DeploymentResult, VercelDeployment } from '../../types/index.js';

/**
 * Vercel deployment service
 *
 * Handles deployment tracking and preview URL retrieval for Vercel deployments.
 *
 * How it works:
 * 1. When a PR is created, Vercel automatically deploys it (if GitHub integration is set up)
 * 2. We poll the Vercel API to find the deployment for our branch
 * 3. We wait for deployment to reach "READY" state
 * 4. We return the preview URL
 *
 * Note: Vercel GitHub integration must be configured for auto-deployment.
 */
class VercelDeploymentService {
  private vercelToken?: string;
  private vercelProjectId?: string;

  constructor() {
    this.vercelToken = config.deployment.vercelToken;
    this.vercelProjectId = config.deployment.vercelProjectId;
  }

  /**
   * Wait for a deployment to complete and return preview URL
   *
   * @param branchName - The branch that was pushed (Vercel deploys branches automatically)
   * @param maxWaitMinutes - Maximum time to wait for deployment (default: 5 minutes)
   */
  async waitForDeployment(
    branchName: string,
    maxWaitMinutes: number = 5
  ): Promise<DeploymentResult> {
    try {
      if (!this.vercelToken || !this.vercelProjectId) {
        logger.warn('Vercel credentials not configured, skipping deployment tracking');
        return {
          success: true,
          url: 'https://vercel-auto-deploy.example.com', // Placeholder
          status: 'READY',
        };
      }

      logger.info('⏳ Waiting for Vercel deployment', {
        branch: branchName,
        maxWait: `${maxWaitMinutes}min`,
      });

      // Give Vercel a few seconds to trigger the deployment
      await this.sleep(10000); // 10 seconds

      // Poll for deployment
      const deployment = await this.pollForDeployment(branchName, maxWaitMinutes);

      if (!deployment) {
        throw new Error('Deployment not found or timed out');
      }

      logger.success('Deployment ready!', {
        url: deployment.url,
        deploymentId: deployment.id,
      });

      return {
        success: true,
        url: `https://${deployment.url}`,
        deploymentId: deployment.id,
        status: deployment.readyState,
      };
    } catch (error) {
      logger.error('❌ Deployment tracking failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Poll Vercel API for deployment matching our branch
   */
  private async pollForDeployment(
    branchName: string,
    maxWaitMinutes: number
  ): Promise<VercelDeployment | null> {
    const maxAttempts = (maxWaitMinutes * 60) / 10; // Check every 10 seconds
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts++;

      try {
        // Get recent deployments
        const deployments = await this.getRecentDeployments();

        // Find deployment for our branch
        const deployment = deployments.find(
          (d) =>
            d.meta?.githubCommitRef === branchName &&
            d.projectId === this.vercelProjectId
        );

        if (deployment) {
          logger.debug('Found deployment', {
            id: deployment.id,
            state: deployment.readyState,
            attempt: attempts,
          });

          // Check if ready
          if (deployment.readyState === 'READY') {
            return deployment as VercelDeployment;
          }

          // Check if failed
          if (deployment.readyState === 'ERROR' || deployment.readyState === 'CANCELED') {
            throw new Error(`Deployment ${deployment.readyState.toLowerCase()}`);
          }

          // Still building, continue polling
          logger.debug('Deployment still building...', {
            state: deployment.readyState,
            attempt: attempts,
          });
        } else {
          logger.debug('Deployment not found yet, waiting...', {
            attempt: attempts,
          });
        }
      } catch (error) {
        logger.warn('Error fetching deployments', {
          error: error instanceof Error ? error.message : String(error),
          attempt: attempts,
        });
      }

      // Wait before next attempt
      await this.sleep(10000); // 10 seconds
    }

    logger.error('Deployment timeout - exceeded maximum wait time');
    return null;
  }

  /**
   * Get recent deployments from Vercel API
   */
  private async getRecentDeployments(): Promise<any[]> {
    try {
      const response = await fetch(
        `https://api.vercel.com/v6/deployments?projectId=${this.vercelProjectId}&limit=20`,
        {
          headers: {
            Authorization: `Bearer ${this.vercelToken}`,
          },
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Vercel API error: ${response.status} ${errorText}`);
      }

      const data = (await response.json()) as { deployments: any[] };
      return data.deployments || [];
    } catch (error) {
      logger.error('Failed to fetch deployments from Vercel', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Trigger a manual deployment (alternative method)
   *
   * Only needed if auto-deployment isn't configured.
   * Most setups use GitHub integration which deploys automatically.
   */
  async triggerManualDeployment(branchName: string): Promise<DeploymentResult> {
    try {
      if (!this.vercelToken || !this.vercelProjectId) {
        throw new Error('Vercel credentials not configured');
      }

      logger.info('🚀 Triggering manual Vercel deployment', { branch: branchName });

      const response = await fetch('https://api.vercel.com/v13/deployments', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.vercelToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: this.vercelProjectId,
          project: this.vercelProjectId,
          target: 'preview',
          gitSource: {
            type: 'github',
            ref: branchName,
          },
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Vercel API error: ${error}`);
      }

      const deployment = (await response.json()) as { id: string };
      logger.debug('Deployment triggered', { id: deployment.id });

      // Wait for it to complete
      const url = await this.waitForDeploymentById(deployment.id);

      return {
        success: true,
        url,
        deploymentId: deployment.id,
        status: 'READY',
      };
    } catch (error) {
      logger.error('Manual deployment failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Wait for a specific deployment to complete
   */
  private async waitForDeploymentById(
    deploymentId: string,
    maxWaitMinutes: number = 5
  ): Promise<string> {
    const maxAttempts = (maxWaitMinutes * 60) / 10;
    let attempts = 0;

    while (attempts < maxAttempts) {
      await this.sleep(10000);

      const response = await fetch(
        `https://api.vercel.com/v13/deployments/${deploymentId}`,
        {
          headers: {
            Authorization: `Bearer ${this.vercelToken}`,
          },
        }
      );

      const data = (await response.json()) as {
        readyState: string;
        url: string;
      };

      if (data.readyState === 'READY') {
        return `https://${data.url}`;
      }

      if (data.readyState === 'ERROR') {
        throw new Error('Deployment failed');
      }

      attempts++;
    }

    throw new Error('Deployment timeout');
  }

  /**
   * Utility sleep function
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const vercelDeploymentService = new VercelDeploymentService();
