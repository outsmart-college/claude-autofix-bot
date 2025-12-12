import express, { Request, Response } from 'express';
import crypto from 'crypto';

// Initialize Express app first, before loading config
const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Track configuration state
let configError: string | null = null;
let config: any = null;
let logger: any = console;
let jobQueue: any = null;

// Try to load configuration
try {
  const configModule = await import('./config/index.js');
  config = configModule.config;

  const loggerModule = await import('./utils/logger.js');
  logger = loggerModule.logger;

  // Set logger for thread tracking module
  const threadTrackingModule = await import('./utils/thread-tracking.js');
  threadTrackingModule.setThreadTrackingLogger(logger);

  const queueModule = await import('./utils/queue.js');
  jobQueue = queueModule.jobQueue;

  const processorModule = await import('./handlers/issue-processor.js');
  jobQueue.setHandler(processorModule.processIssue);
} catch (error) {
  configError = error instanceof Error ? error.message : String(error);
  console.error('Failed to load configuration:', configError);
}

// Import types (these don't depend on config)
import { SlackEventSchema, SlackVerificationSchema, IssueJob, ImageAttachment } from './types/index.js';
import { extractPRReferences, PRReference } from './utils/pr-references.js';
import {
  processedMessages,
  activeThreads,
  completedThreads,
  setThreadTrackingLogger,
  markThreadCompleted,
  clearActiveThread,
  getThreadContext
} from './utils/thread-tracking.js';

// Re-export for backwards compatibility
export { markThreadCompleted, clearActiveThread };

// Middleware to parse JSON and capture raw body for signature verification
app.use(express.json({
  verify: (req: Request, _res: Response, buf: Buffer) => {
    // Store raw body for signature verification
    (req as any).rawBody = buf.toString();
  }
}));

/**
 * Verify Slack request signature
 */
function verifySlackSignature(req: Request): boolean {
  if (!config?.slack?.signingSecret) {
    logger.warn('Slack signing secret not configured');
    return false;
  }

  const timestamp = req.headers['x-slack-request-timestamp'] as string;
  const slackSignature = req.headers['x-slack-signature'] as string;

  if (!timestamp || !slackSignature) {
    logger.warn('Missing Slack signature headers');
    return false;
  }

  // Prevent replay attacks
  const currentTime = Math.floor(Date.now() / 1000);
  const requestTime = parseInt(timestamp, 10);

  if (Math.abs(currentTime - requestTime) > 300) {
    logger.warn('Slack request timestamp too old', { timestamp, currentTime });
    return false;
  }

  // Compute signature using raw body
  const rawBody = (req as any).rawBody || JSON.stringify(req.body);
  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const expectedSignature = `v0=${crypto
    .createHmac('sha256', config.slack.signingSecret)
    .update(sigBasestring)
    .digest('hex')}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(slackSignature),
      Buffer.from(expectedSignature)
    );
  } catch {
    return false;
  }
}

/**
 * Health check endpoint
 */
app.get('/api/health', (_req: Request, res: Response) => {
  // Always return 200 so Railway health check passes
  // Include config status in body for debugging
  if (configError) {
    res.status(200).json({
      status: 'unconfigured',
      error: 'Configuration failed to load',
      details: configError,
      timestamp: new Date().toISOString(),
      version: '2.0.0',
      platform: 'railway',
      action: 'Set environment variables in Railway dashboard',
    });
    return;
  }

  const services = {
    slack: {
      configured: !!config?.slack?.botToken && !!config?.slack?.signingSecret,
      channelMonitored: !!config?.slack?.channelId,
    },
    claude: {
      configured: !!config?.claude?.apiKey,
    },
    github: {
      configured: !!config?.github?.token && !!config?.github?.username,
      targetRepo: config?.github?.targetRepoUrl,
      baseBranch: config?.github?.baseBranch,
    },
    vercel: {
      configured: !!config?.deployment?.vercelToken && !!config?.deployment?.vercelProjectId,
    },
  };

  const isHealthy =
    services.slack.configured &&
    services.claude.configured &&
    services.github.configured;

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    environment: config?.nodeEnv || 'unknown',
    version: '2.0.0',
    platform: 'railway',
    services,
  });
});

/**
 * Root endpoint
 */
app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'Claude AutoFix Bot',
    version: '2.0.0',
    platform: 'railway',
    status: 'running',
    endpoints: {
      health: '/api/health',
      slack: '/api/slack-events',
    },
  });
});

/**
 * Slack Events API handler
 */
app.post('/api/slack-events', async (req: Request, res: Response) => {
  // Check if system is configured
  if (configError || !config || !jobQueue) {
    logger.error('System not configured properly', { configError });
    res.status(503).json({ error: 'Service not configured' });
    return;
  }

  // Verify request is from Slack
  if (!verifySlackSignature(req)) {
    logger.warn('Invalid Slack signature - possible unauthorized request');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const body = req.body;

    // Handle URL Verification Challenge
    const verification = SlackVerificationSchema.safeParse(body);
    if (verification.success) {
      logger.info('URL verification challenge received');
      res.status(200).json({ challenge: verification.data.challenge });
      return;
    }

    // Parse and Validate Event
    const event = SlackEventSchema.safeParse(body);
    if (!event.success) {
      logger.warn('Invalid event format', {
        errors: event.error.errors.map((e) => e.message),
      });
      res.status(400).json({ error: 'Invalid event format' });
      return;
    }

    const { channel, text, ts, thread_ts, user, bot_id, subtype, files } = event.data.event;
    const eventType = event.data.event.type;

    // Filter Out Unwanted Messages

    // Only process regular message events (not message_changed, message_deleted, etc.)
    if (eventType !== 'message') {
      logger.debug('Ignoring non-message event', { eventType });
      res.status(200).json({ ok: true });
      return;
    }

    // Ignore most message subtypes (bot_message, message_changed, message_deleted, etc.)
    // BUT allow file_share - this is how Slack sends messages with attached images
    if (subtype && subtype !== 'file_share') {
      logger.debug('Ignoring message subtype', { subtype });
      res.status(200).json({ ok: true });
      return;
    }

    // Ignore bot messages - the proper way to detect bots is via bot_id field
    if (bot_id) {
      logger.debug('Ignoring bot message', { bot_id });
      res.status(200).json({ ok: true });
      return;
    }

    // Also ignore if user field is missing or looks like a bot
    if (!user || user === 'USLACKBOT') {
      logger.debug('Ignoring message without valid user', { user });
      res.status(200).json({ ok: true });
      return;
    }

    // Check if we've already processed this specific message (prevent duplicates)
    if (processedMessages.has(ts)) {
      logger.debug('Message already processed', { ts });
      res.status(200).json({ ok: true });
      return;
    }

    // Determine if this is a thread reply vs a new top-level message
    const isThreadReply = !!(thread_ts && thread_ts !== ts);
    const threadKey = thread_ts || ts;

    // For thread replies: only process if it's a follow-up to a completed thread
    // This allows team members to give additional instructions after the PR is created
    if (isThreadReply) {
      // Ignore if this thread is currently being processed (avoid interference)
      if (activeThreads.has(threadKey)) {
        logger.debug('Thread is currently being processed, ignoring reply', { threadKey });
        res.status(200).json({ ok: true });
        return;
      }

      // Only process replies to threads we've worked on before
      if (!completedThreads.has(threadKey)) {
        logger.debug('Thread reply to unknown thread, ignoring', { threadKey });
        res.status(200).json({ ok: true });
        return;
      }

      logger.info('Processing follow-up instruction in completed thread', { threadKey, user });
    } else {
      // For new top-level messages: check if we already have an active job
      if (activeThreads.has(threadKey)) {
        logger.debug('Thread already has active processing', { threadKey });
        res.status(200).json({ ok: true });
        return;
      }
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

    // Ignore very short messages
    const trimmedText = (text || '').trim();
    if (trimmedText.length < 10) {
      logger.debug('Message too short to process', { length: trimmedText.length });
      res.status(200).json({ ok: true });
      return;
    }

    // Ignore @mentions (handled separately) - but allow in thread replies
    if (!isThreadReply && trimmedText.includes('<@U')) {
      logger.debug('Ignoring @mention in top-level message');
      res.status(200).json({ ok: true });
      return;
    }

    // Extract PR references from the message
    // Parse default owner/repo from TARGET_REPO_URL for simple #123 references
    const repoUrlMatch = config.github.targetRepoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    const defaultOwner = repoUrlMatch?.[1] || 'owner';
    const defaultRepo = repoUrlMatch?.[2] || 'repo';
    const prReferences = extractPRReferences(trimmedText, defaultOwner, defaultRepo);

    // Extract image attachments (screenshots, etc.)
    // Only include image types that Claude can process
    const imageAttachments: ImageAttachment[] = [];
    if (files && files.length > 0) {
      for (const file of files) {
        // Only include image files
        if (file.mimetype.startsWith('image/')) {
          imageAttachments.push({
            url: file.url_private,
            filename: file.name,
            mimetype: file.mimetype,
          });
        }
      }
      if (imageAttachments.length > 0) {
        logger.info('Found image attachments', {
          count: imageAttachments.length,
          files: imageAttachments.map(f => f.filename),
        });
      }
    }

    // Create Job for Async Processing
    // For follow-ups, include the thread context so we can continue on the same branch
    const existingThreadContext = isThreadReply ? getThreadContext(threadKey) : undefined;

    const job: IssueJob = {
      id: ts,
      text: trimmedText,
      channel,
      threadTs: thread_ts || ts,
      userId: user,
      timestamp: new Date(),
      retryCount: 0,
      isFollowUp: isThreadReply,
      prReferences: prReferences.length > 0 ? prReferences : undefined,
      images: imageAttachments.length > 0 ? imageAttachments : undefined,
      threadContext: existingThreadContext,
    };

    // Queue the job for background processing
    await jobQueue.enqueue(job);

    // Mark message and thread as being processed to prevent duplicates
    processedMessages.add(ts);
    activeThreads.add(job.threadTs);

    logger.success('Job enqueued successfully', {
      jobId: job.id,
      queueLength: jobQueue.getQueueLength(),
      isFollowUp: isThreadReply,
      prReferences: prReferences.length > 0 ? prReferences.map((r: PRReference) => `${r.owner}/${r.repo}#${r.prNumber}`) : undefined,
      images: imageAttachments.length > 0 ? imageAttachments.length : undefined,
      preview: trimmedText.substring(0, 100),
    });

    // Acknowledge immediately (within 3 seconds!)
    res.status(200).json({ ok: true });
  } catch (error) {
    logger.error('Event handler error', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start server - bind to 0.0.0.0 for Railway container networking
app.listen(PORT, '0.0.0.0', () => {
  const targetRepo = config?.github?.targetRepoUrl?.substring(0, 40) || 'NOT CONFIGURED';
  const channelId = config?.slack?.channelId || 'NOT CONFIGURED';
  const status = configError ? 'CONFIG ERROR' : 'READY';

  console.log(`
╔═══════════════════════════════════════════════════════════╗
║            Claude AutoFix Bot v2.0.0                       ║
║            Running on Railway                              ║
╠═══════════════════════════════════════════════════════════╣
║  Status: ${status.padEnd(48)}║
║  Port: ${String(PORT).padEnd(50)}║
║  Health: /api/health                                       ║
║  Slack:  /api/slack-events                                 ║
╠═══════════════════════════════════════════════════════════╣
║  Target Repo: ${targetRepo.padEnd(42)}║
║  Channel: ${channelId.padEnd(47)}║
╚═══════════════════════════════════════════════════════════╝
  `);

  if (configError) {
    console.error('⚠️  Configuration Error:', configError);
    console.error('   Set environment variables in Railway dashboard and redeploy.');
  }
});

export default app;
