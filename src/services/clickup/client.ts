import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

export interface ClickUpTicket {
  id: string;
  url: string;
  name: string;
}

interface ClickUpTaskResponse {
  id: string;
  url: string;
  name: string;
}

/**
 * ClickUp service for creating and updating bug tickets.
 *
 * Created before git work so the task ID can be embedded in
 * branch names, commit messages, and PR titles for automatic linking.
 */
class ClickUpService {
  private baseUrl = 'https://api.clickup.com/api/v2';

  private get headers(): Record<string, string> {
    return {
      Authorization: config.clickup.apiKey,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Create a ClickUp bug ticket from a Slack bug report.
   *
   * Returns the ticket with id/url/name, or null if creation fails.
   * Failures are logged but never thrown — callers should handle null gracefully.
   */
  async createBugTicket(params: {
    summary: string;
    slackText: string;
    reporterName: string;
    slackPermalink: string;
    severity: 'normal' | 'high' | 'low';
  }): Promise<ClickUpTicket | null> {
    if (!config.clickup.apiKey) {
      logger.info('ClickUp API key not configured — skipping ticket creation');
      return null;
    }

    try {
      const { summary, slackText, reporterName, slackPermalink, severity } = params;

      const taskName = `Bug: ${summary}`;
      const dateStr = new Date().toISOString().split('T')[0];

      const markdownDescription = `**Description:** ${slackText.substring(0, 500)}

**Reporter:** ${reporterName} via Slack on ${dateStr}

**Slack Thread:** ${slackPermalink}

**Autofix Status:** Fix in progress — PR will be linked automatically.`;

      const priority = severity === 'high' ? 2 : severity === 'low' ? 4 : 3;

      const response = await fetch(`${this.baseUrl}/list/${config.clickup.listId}/task`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          name: taskName,
          markdown_description: markdownDescription,
          priority,
          tags: ['Bug'],
          status: 'now',
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error('Failed to create ClickUp ticket', { error: errorText, status: response.status });
        return null;
      }

      const data = (await response.json()) as ClickUpTaskResponse;

      logger.info('ClickUp ticket created', { id: data.id, url: data.url, name: data.name });

      return {
        id: data.id,
        url: data.url,
        name: data.name,
      };
    } catch (error) {
      logger.error('ClickUp ticket creation threw an exception', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Append a PR link to an existing ClickUp task description.
   */
  async appendPRLink(taskId: string, prUrl: string): Promise<void> {
    if (!config.clickup.apiKey) return;

    try {
      // Fetch current description
      const getResp = await fetch(`${this.baseUrl}/task/${taskId}`, {
        method: 'GET',
        headers: this.headers,
      });

      if (!getResp.ok) {
        logger.warn('Failed to fetch ClickUp task for PR link update', { taskId });
        return;
      }

      const taskData = (await getResp.json()) as { description: string };
      const currentDesc = taskData.description || '';

      const updatedDesc = currentDesc.replace(
        /\*\*Autofix Status:\*\* Fix in progress — PR will be linked automatically\./,
        `**Autofix Status:** Fix created — see PR below.`,
      ) + `\n\n**Autofix PR:** ${prUrl}`;

      const response = await fetch(`${this.baseUrl}/task/${taskId}`, {
        method: 'PUT',
        headers: this.headers,
        body: JSON.stringify({ markdown_description: updatedDesc }),
      });

      if (response.ok) {
        logger.info('ClickUp task updated with PR link', { taskId, prUrl });
      } else {
        logger.warn('Failed to update ClickUp task with PR link', { taskId });
      }
    } catch (error) {
      logger.warn('Exception updating ClickUp task with PR link', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Mark autofix as failed on the ClickUp ticket.
   */
  async markAutofixFailed(taskId: string, errorMessage: string): Promise<void> {
    if (!config.clickup.apiKey) return;

    try {
      const getResp = await fetch(`${this.baseUrl}/task/${taskId}`, {
        method: 'GET',
        headers: this.headers,
      });

      if (!getResp.ok) return;

      const taskData = (await getResp.json()) as { description: string };
      const currentDesc = taskData.description || '';

      const updatedDesc = currentDesc.replace(
        /\*\*Autofix Status:\*\* Fix in progress — PR will be linked automatically\./,
        `**Autofix Status:** Autofix attempt failed. Manual fix required.\n\n**Error:** ${errorMessage}`,
      );

      await fetch(`${this.baseUrl}/task/${taskId}`, {
        method: 'PUT',
        headers: this.headers,
        body: JSON.stringify({ markdown_description: updatedDesc }),
      });
    } catch {
      // Best effort — don't let this break anything
    }
  }
}

export const clickupService = new ClickUpService();
