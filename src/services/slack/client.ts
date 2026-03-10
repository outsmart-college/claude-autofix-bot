import { WebClient } from '@slack/web-api';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import type { ImageAttachment } from '../../types/index.js';

/**
 * Slack service for posting messages and reactions
 *
 * Wraps the Slack Web API client with error handling and logging.
 * All methods are fail-safe - they log errors but don't throw.
 */
class SlackService {
  private client: WebClient;

  constructor() {
    this.client = new WebClient(config.slack.botToken);
  }

  /**
   * Post a message to a Slack channel or thread
   *
   * @returns Message timestamp for future updates
   */
  async postMessage(
    channel: string,
    text: string,
    threadTs?: string
  ): Promise<{ ts: string }> {
    try {
      logger.debug('Posting message to Slack', { channel, threadTs });

      const result = await this.client.chat.postMessage({
        channel,
        text,
        thread_ts: threadTs,
        unfurl_links: false,
        unfurl_media: false,
      });

      if (!result.ok || !result.ts) {
        throw new Error(`Slack API error: ${result.error || 'Unknown error'}`);
      }

      logger.debug('✅ Message posted successfully', { ts: result.ts });
      return { ts: result.ts };
    } catch (error) {
      logger.error('❌ Failed to post Slack message', {
        error: error instanceof Error ? error.message : String(error),
        channel,
      });
      throw error;
    }
  }

  /**
   * Update an existing message
   *
   * Useful for status updates (e.g., "Analyzing..." -> "Deploying..." -> "Done!")
   */
  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    try {
      logger.debug('Updating Slack message', { channel, ts });

      const result = await this.client.chat.update({
        channel,
        ts,
        text,
      });

      if (!result.ok) {
        throw new Error(`Slack API error: ${result.error || 'Unknown error'}`);
      }

      logger.debug('✅ Message updated successfully');
    } catch (error) {
      logger.error('❌ Failed to update Slack message', {
        error: error instanceof Error ? error.message : String(error),
        channel,
        ts,
      });
      throw error;
    }
  }

  /**
   * Add a reaction emoji to a message
   *
   * Non-critical operation - logs warning on failure but doesn't throw
   */
  async addReaction(channel: string, timestamp: string, emoji: string): Promise<void> {
    try {
      await this.client.reactions.add({
        channel,
        timestamp,
        name: emoji,
      });

      logger.debug('✅ Reaction added', { emoji, timestamp });
    } catch (error) {
      // Non-critical - just log warning
      logger.warn('⚠️  Failed to add reaction', {
        error: error instanceof Error ? error.message : String(error),
        emoji,
      });
    }
  }

  /**
   * Post a formatted message with blocks (for v2 - rich UI)
   *
   * Falls back to plain text if blocks fail
   */
  async postRichMessage(
    channel: string,
    text: string,
    blocks: any[],
    threadTs?: string
  ): Promise<{ ts: string }> {
    try {
      const result = await this.client.chat.postMessage({
        channel,
        text, // Fallback text for notifications
        blocks,
        thread_ts: threadTs,
      });

      if (!result.ok || !result.ts) {
        throw new Error('Failed to post rich message');
      }

      return { ts: result.ts };
    } catch (error) {
      logger.error('Failed to post rich message, falling back to plain text', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Fallback to simple text message
      return this.postMessage(channel, text, threadTs);
    }
  }

  /**
   * Post an ephemeral message (only visible to one user)
   */
  async postEphemeral(
    channel: string,
    user: string,
    text: string
  ): Promise<void> {
    try {
      await this.client.chat.postEphemeral({
        channel,
        user,
        text,
      });
    } catch (error) {
      logger.warn('Failed to post ephemeral message', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Fetch all messages in a thread (parent + replies)
   *
   * Returns human messages in chronological order, excluding bot messages.
   * Used to build full thread context when the bot is @mentioned in a thread.
   */
  async getThreadMessages(
    channel: string,
    threadTs: string,
    excludeTs?: string
  ): Promise<{ user: string; text: string; ts: string }[]> {
    try {
      logger.debug('Fetching thread messages', { channel, threadTs });

      const result = await this.client.conversations.replies({
        channel,
        ts: threadTs,
        limit: 100,
        inclusive: true, // Include the parent message
      });

      if (!result.ok || !result.messages) {
        logger.warn('Failed to fetch thread messages', { error: result.error });
        return [];
      }

      // Filter to human messages only (exclude bot messages and optionally the trigger message)
      const humanMessages = result.messages
        .filter((msg: any) => {
          if (msg.bot_id || msg.subtype === 'bot_message') return false;
          if (excludeTs && msg.ts === excludeTs) return false;
          return true;
        })
        .map((msg: any) => ({
          user: msg.user || 'unknown',
          text: msg.text || '',
          ts: msg.ts,
        }));

      logger.debug('Thread messages fetched', {
        total: result.messages.length,
        human: humanMessages.length,
      });

      return humanMessages;
    } catch (error) {
      logger.error('Failed to fetch thread messages', {
        error: error instanceof Error ? error.message : String(error),
        channel,
        threadTs,
      });
      return [];
    }
  }

  /**
   * Download images from Slack private URLs
   *
   * Slack files require authentication via the bot token.
   * Returns the image data as base64 strings for passing to Claude.
   */
  async downloadImages(
    images: ImageAttachment[]
  ): Promise<{ filename: string; mimetype: string; base64: string }[]> {
    const results: { filename: string; mimetype: string; base64: string }[] = [];

    for (const image of images) {
      try {
        logger.debug('Downloading image from Slack', { filename: image.filename });

        const response = await fetch(image.url, {
          headers: {
            'Authorization': `Bearer ${config.slack.botToken}`,
          },
        });

        if (!response.ok) {
          logger.warn('Failed to download image', {
            filename: image.filename,
            status: response.status,
          });
          continue;
        }

        const arrayBuffer = await response.arrayBuffer();
        const base64 = Buffer.from(arrayBuffer).toString('base64');

        results.push({
          filename: image.filename,
          mimetype: image.mimetype,
          base64,
        });

        logger.debug('Image downloaded successfully', {
          filename: image.filename,
          sizeKb: Math.round(arrayBuffer.byteLength / 1024),
        });
      } catch (error) {
        logger.warn('Error downloading image', {
          filename: image.filename,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return results;
  }
}

// Export singleton instance
export const slackService = new SlackService();
