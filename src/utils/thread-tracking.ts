/**
 * Thread tracking utilities for managing active and completed threads
 * Separated from server.ts to avoid circular dependencies
 */

import type { ThreadContext } from '../types/index.js';

// Track processed messages and threads to prevent duplicate processing
// Note: This is in-memory, so it resets on server restart. For MVP this is acceptable.
export const processedMessages = new Set<string>();
export const activeThreads = new Set<string>();    // Threads currently being processed
export const completedThreads = new Set<string>(); // Threads that have completed (for follow-up instructions)

// Store context for completed threads (branch name, PR URL, etc.) to enable follow-ups
const threadContextMap = new Map<string, ThreadContext>();

let logger: any = console;

/**
 * Set the logger instance (called during server initialization)
 */
export function setThreadTrackingLogger(loggerInstance: any): void {
  logger = loggerInstance;
}

/**
 * Mark a thread as completed (called by issue-processor when job finishes)
 * This moves the thread from active to completed, allowing follow-up messages
 * @param threadTs - The thread timestamp
 * @param context - Optional context to store (branch name, PR URL, etc.) for follow-ups
 */
export function markThreadCompleted(threadTs: string, context?: ThreadContext): void {
  activeThreads.delete(threadTs);
  completedThreads.add(threadTs);
  if (context) {
    threadContextMap.set(threadTs, context);
    logger.debug('Thread marked as completed with context', {
      threadTs,
      branchName: context.branchName,
      prUrl: context.prUrl,
    });
  } else {
    logger.debug('Thread marked as completed', { threadTs });
  }
}

/**
 * Get the context for a completed thread (branch name, PR URL, etc.)
 * Returns undefined if thread has no context or isn't completed
 */
export function getThreadContext(threadTs: string): ThreadContext | undefined {
  return threadContextMap.get(threadTs);
}

/**
 * Check if a thread has context stored (was completed with a branch/PR)
 */
export function hasThreadContext(threadTs: string): boolean {
  return threadContextMap.has(threadTs);
}

/**
 * Mark a thread as no longer active without completing (called on failure)
 */
export function clearActiveThread(threadTs: string): void {
  activeThreads.delete(threadTs);
  logger.debug('Active thread cleared', { threadTs });
}
