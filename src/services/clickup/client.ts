import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { ImageAttachment } from '../../types/index.js';

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
  /**
   * Use Claude to summarize raw Slack thread context into a clean bug description.
   * Filters out bot-debugging chatter and @mentions, focuses on the actual bug.
   */
  private async summarizeThreadContext(rawText: string): Promise<{ title: string; description: string }> {
    try {
      const anthropic = new Anthropic({ apiKey: config.claude.apiKey });
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `You are summarizing a Slack bug report thread for a ClickUp ticket. The thread may contain:
- The original bug report (the most important part)
- Debugging discussion between team members (less important)
- Bot commands and meta-discussion about tooling (ignore these)

Extract ONLY information relevant to the actual bug being reported. Ignore any discussion about bots, tooling, API keys, or debugging the reporting process itself.

Strip all Slack @mentions (like <@U12345>) and replace with generic references if needed.

Return your response in this exact format:
TITLE: [A concise bug title, max 60 chars, no prefix like "Bug:"]
DESCRIPTION: [A clean 1-3 sentence description of the bug, what happened, and any reproduction steps mentioned]

Here is the raw Slack thread:
${rawText.substring(0, 1500)}`,
        }],
      });

      const text = response.content[0].type === 'text' ? response.content[0].text : '';
      const titleMatch = text.match(/TITLE:\s*(.+)/);
      const descMatch = text.match(/DESCRIPTION:\s*([\s\S]+)/);

      return {
        title: titleMatch?.[1]?.trim().substring(0, 80) || '',
        description: descMatch?.[1]?.trim() || '',
      };
    } catch (error) {
      logger.warn('Failed to summarize thread with Claude, using raw text', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { title: '', description: '' };
    }
  }

  async createBugTicket(params: {
    summary: string;
    slackText: string;
    reporterName: string;
    slackPermalink: string;
    severity: 'normal' | 'high' | 'low';
    mode?: 'ticket-only' | 'pr-only' | 'full';
    channelId?: string;
  }): Promise<ClickUpTicket | null> {
    if (!config.clickup.apiKey) {
      logger.info('ClickUp API key not configured — skipping ticket creation');
      return null;
    }

    try {
      const { summary, slackText, reporterName, slackPermalink, severity, mode = 'full', channelId } = params;

      // Resolve the ClickUp list: channel-specific mapping takes priority, then default
      const listId = (channelId && config.clickup.channelListMap[channelId]) || config.clickup.listId;
      logger.info('Resolved ClickUp list', { channelId, listId, isChannelSpecific: !!(channelId && config.clickup.channelListMap[channelId]) });

      // Use Claude to generate a clean summary from raw thread context
      const ai = await this.summarizeThreadContext(slackText);
      const taskName = `Bug: ${ai.title || summary}`;
      const cleanDescription = ai.description || slackText.substring(0, 500);
      const dateStr = new Date().toISOString().split('T')[0];

      let markdownDescription = `**Description:** ${cleanDescription}

**Reporter:** ${reporterName} via Slack on ${dateStr}

**Slack Thread:** ${slackPermalink}`;

      // Only show autofix status if a PR will be created
      if (mode === 'full') {
        markdownDescription += `\n\n**Autofix Status:** Fix in progress — PR will be linked automatically.`;
      }

      const priority = severity === 'high' ? 2 : severity === 'low' ? 4 : 3;

      const response = await fetch(`${this.baseUrl}/list/${listId}/task`, {
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
   * Download images from Slack and attach them to a ClickUp task.
   * Uses the ClickUp attachment API with multipart form upload.
   */
  async attachImages(taskId: string, images: ImageAttachment[]): Promise<void> {
    if (!config.clickup.apiKey || images.length === 0) return;

    for (const image of images) {
      try {
        // Download from Slack using bot token
        const slackResp = await fetch(image.url, {
          headers: { 'Authorization': `Bearer ${config.slack.botToken}` },
        });

        if (!slackResp.ok) {
          logger.warn('Failed to download image from Slack for ClickUp', {
            filename: image.filename,
            status: slackResp.status,
          });
          continue;
        }

        const arrayBuffer = await slackResp.arrayBuffer();
        const blob = new Blob([arrayBuffer], { type: image.mimetype });

        // Upload to ClickUp as task attachment
        const formData = new FormData();
        formData.append('attachment', blob, image.filename);

        const clickupResp = await fetch(`${this.baseUrl}/task/${taskId}/attachment`, {
          method: 'POST',
          headers: { 'Authorization': config.clickup.apiKey },
          body: formData,
        });

        if (clickupResp.ok) {
          logger.info('Image attached to ClickUp task', { taskId, filename: image.filename });
        } else {
          const errText = await clickupResp.text();
          logger.warn('Failed to attach image to ClickUp task', {
            taskId,
            filename: image.filename,
            status: clickupResp.status,
            error: errText,
          });
        }
      } catch (error) {
        logger.warn('Exception attaching image to ClickUp', {
          taskId,
          filename: image.filename,
          error: error instanceof Error ? error.message : String(error),
        });
      }
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
