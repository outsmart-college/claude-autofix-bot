import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { SlackEventSchema, SlackVerificationSchema, IssueJob } from '../src/types/index.js';
import { config } from '../src/config/index.js';
import { logger } from '../src/utils/logger.js';
import { jobQueue } from '../src/utils/queue.js';
import { processIssue } from '../src/handlers/issue-processor.js';

// Initialize queue handler on module load
jobQueue.setHandler(processIssue);

/**
 * Verify Slack request signature to ensure requests are from Slack
 *
 * Security: This prevents malicious actors from triggering our bot
 * by forging requests. Slack signs all requests with a secret.
 *
 * @see https://api.slack.com/authentication/verifying-requests-from-slack
 */
function verifySlackSignature(req: VercelRequest): boolean {
  const timestamp = req.headers['x-slack-request-timestamp'] as string;
  const slackSignature = req.headers['x-slack-signature'] as string;

  if (!timestamp || !slackSignature) {
    logger.warn('Missing Slack signature headers');
    return false;
  }

  // Prevent replay attacks - request must be within 5 minutes
  const currentTime = Math.floor(Date.now() / 1000);
  const requestTime = parseInt(timestamp, 10);

  if (Math.abs(currentTime - requestTime) > 300) {
    logger.warn('Slack request timestamp too old (possible replay attack)', {
      timestamp,
      currentTime,
      age: Math.abs(currentTime - requestTime),
    });
    return false;
  }

  // Compute signature
  const body = JSON.stringify(req.body);
  const sigBasestring = `v0:${timestamp}:${body}`;
  const expectedSignature = `v0=${crypto
    .createHmac('sha256', config.slack.signingSecret)
    .update(sigBasestring)
    .digest('hex')}`;

  // Timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(slackSignature),
      Buffer.from(expectedSignature)
    );
  } catch {
    // Buffer lengths don't match
    return false;
  }
}

/**
 * Main Slack Events API handler
 *
 * This webhook receives all events from Slack:
 * 1. URL verification (initial setup)
 * 2. Message events (ongoing operation)
 *
 * CRITICAL: Must respond within 3 seconds or Slack will retry
 */
export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only accept POST requests
  if (req.method !== 'POST') {
    logger.warn('Invalid request method', { method: req.method });
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Verify request is from Slack
  if (!verifySlackSignature(req)) {
    logger.warn('❌ Invalid Slack signature - possible unauthorized request');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const body = req.body;

    // ============================================
    // STEP 1: Handle URL Verification Challenge
    // ============================================
    // When you first configure the webhook in Slack,
    // Slack sends a challenge parameter to verify your endpoint
    const verification = SlackVerificationSchema.safeParse(body);
    if (verification.success) {
      logger.info('📝 URL verification challenge received');
      res.status(200).json({ challenge: verification.data.challenge });
      return;
    }

    // ============================================
    // STEP 2: Parse and Validate Event
    // ============================================
    const event = SlackEventSchema.safeParse(body);
    if (!event.success) {
      logger.warn('Invalid event format', {
        errors: event.error.errors.map((e) => e.message),
      });
      res.status(400).json({ error: 'Invalid event format' });
      return;
    }

    const { type, channel, text, ts, thread_ts, user, bot_id, subtype } = event.data.event;

    // ============================================
    // STEP 3: Filter Out Unwanted Messages
    // ============================================

    // Ignore message subtypes (bot_message, message_changed, message_deleted, etc.)
    if (subtype) {
      logger.debug('Ignoring message subtype', { subtype });
      res.status(200).json({ ok: true });
      return;
    }

    // Ignore messages from bots (prevent infinite loops!) - use bot_id field
    if (bot_id) {
      logger.debug('Ignoring bot message', { bot_id });
      res.status(200).json({ ok: true });
      return;
    }

    // Also check user field for legacy bot detection
    if (!user || user === 'USLACKBOT') {
      logger.debug('Ignoring message without valid user', { user });
      res.status(200).json({ ok: true });
      return;
    }

    // Only process messages in configured channel
    if (channel !== config.slack.channelId) {
      logger.debug('Message not in monitored channel', {
        channel,
        expected: config.slack.channelId,
      });
      res.status(200).json({ ok: true });
      return;
    }

    // Ignore very short messages (likely not actionable)
    const trimmedText = (text || '').trim();
    if (trimmedText.length < 10) {
      logger.debug('Message too short to process', {
        length: trimmedText.length,
      });
      res.status(200).json({ ok: true });
      return;
    }

    // Ignore messages that mention the bot (those are handled separately)
    if (trimmedText.includes('<@U')) {
      logger.debug('Ignoring @mention (handled by different event type)');
      res.status(200).json({ ok: true });
      return;
    }

    // ============================================
    // STEP 4: Create Job for Async Processing
    // ============================================
    const job: IssueJob = {
      id: ts, // Use Slack timestamp as unique ID
      text: trimmedText,
      channel,
      threadTs: thread_ts || ts, // Use thread if in thread, else create new thread
      userId: user,
      timestamp: new Date(),
      retryCount: 0,
    };

    // Queue the job for background processing
    await jobQueue.enqueue(job);

    logger.success('Job enqueued successfully', {
      jobId: job.id,
      queueLength: jobQueue.getQueueLength(),
      preview: trimmedText.substring(0, 100),
    });

    // ============================================
    // STEP 5: Acknowledge Immediately
    // ============================================
    // CRITICAL: Must respond within 3 seconds
    // The actual processing happens asynchronously
    res.status(200).json({ ok: true });
  } catch (error) {
    logger.error('❌ Event handler error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json({ error: 'Internal server error' });
  }
}
