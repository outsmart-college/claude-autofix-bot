import { IssueJob, JobResult } from '../types/index.js';
import { logger } from './logger.js';

type JobHandler = (job: IssueJob) => Promise<JobResult>;

/**
 * Simple in-memory job queue with retry logic
 *
 * For v1 MVP, this is sufficient. For production scale (v2),
 * replace with Redis-based queue (Upstash/Bull) for:
 * - Persistence across restarts
 * - Distributed processing
 * - Better retry/DLQ handling
 */
class AsyncJobQueue {
  private queue: IssueJob[] = [];
  private processing = false;
  private handler: JobHandler | null = null;
  private maxConcurrent = 1; // Process one job at a time (prevents race conditions)
  private maxRetries = 2;

  /**
   * Set the job processing handler
   */
  setHandler(handler: JobHandler): void {
    this.handler = handler;
    logger.debug('Job handler registered');
  }

  /**
   * Add a job to the queue
   */
  async enqueue(job: IssueJob): Promise<void> {
    logger.info('📥 Job enqueued', {
      jobId: job.id,
      preview: job.text.substring(0, 50) + (job.text.length > 50 ? '...' : ''),
      queueLength: this.queue.length + 1,
    });

    this.queue.push(job);

    // Start processing if not already running
    if (!this.processing) {
      // Don't await - let it run in background
      this.process().catch((error) => {
        logger.error('Queue processing error', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  /**
   * Process jobs from the queue
   */
  private async process(): Promise<void> {
    if (this.processing || !this.handler) {
      return;
    }

    this.processing = true;
    logger.debug('Queue processing started');

    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      const retryCount = job.retryCount || 0;

      try {
        logger.processing(`Processing job ${job.id}`, {
          jobId: job.id,
          attempt: retryCount + 1,
          remainingInQueue: this.queue.length,
        });

        const startTime = Date.now();
        const result = await this.handler(job);
        const duration = Date.now() - startTime;

        if (result.status === 'completed') {
          logger.success(`Job completed`, {
            jobId: job.id,
            duration: `${(duration / 1000).toFixed(1)}s`,
            prUrl: result.prUrl,
            previewUrl: result.previewUrl,
          });
        } else {
          logger.failure('Job failed', {
            jobId: job.id,
            duration: `${(duration / 1000).toFixed(1)}s`,
            error: result.error,
          });

          // Retry if we haven't exceeded max retries
          if (retryCount < this.maxRetries) {
            logger.info('🔄 Retrying job', {
              jobId: job.id,
              attempt: retryCount + 2,
              maxRetries: this.maxRetries,
            });

            job.retryCount = retryCount + 1;
            this.queue.push(job); // Re-queue at end
          } else {
            logger.error('Job exhausted all retries', {
              jobId: job.id,
              attempts: this.maxRetries + 1,
            });
          }
        }
      } catch (error) {
        logger.error('💥 Job processing exception', {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });

        // Retry on exception
        if (retryCount < this.maxRetries) {
          logger.info('🔄 Retrying job after exception', {
            jobId: job.id,
            attempt: retryCount + 2,
          });

          job.retryCount = retryCount + 1;
          this.queue.push(job);
        } else {
          logger.error('Job failed after all retry attempts', {
            jobId: job.id,
          });
        }
      }

      // Small delay between jobs to avoid hammering APIs
      if (this.queue.length > 0) {
        await this.sleep(1000);
      }
    }

    this.processing = false;
    logger.debug('Queue processing stopped - queue empty');
  }

  /**
   * Get current queue length
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Check if queue is currently processing
   */
  isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Utility sleep function
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const jobQueue = new AsyncJobQueue();
