/**
 * PR Reference parsing utilities
 * These functions don't require config and can be imported without side effects
 */

export interface PRReference {
  owner: string;
  repo: string;
  prNumber: number;
}

/**
 * Parse a GitHub PR URL or reference to extract owner, repo, and PR number
 * Handles formats like:
 * - https://github.com/owner/repo/pull/123
 * - owner/repo#123
 * - #123 (uses default repo)
 */
export function parsePRReference(text: string, defaultOwner?: string, defaultRepo?: string): PRReference | null {
  // Match full GitHub URL: https://github.com/owner/repo/pull/123
  const urlMatch = text.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
  if (urlMatch) {
    return {
      owner: urlMatch[1],
      repo: urlMatch[2],
      prNumber: parseInt(urlMatch[3], 10),
    };
  }

  // Match owner/repo#123 format
  const repoRefMatch = text.match(/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)#(\d+)/);
  if (repoRefMatch) {
    return {
      owner: repoRefMatch[1],
      repo: repoRefMatch[2],
      prNumber: parseInt(repoRefMatch[3], 10),
    };
  }

  // Match simple #123 format (uses default repo)
  const simpleMatch = text.match(/#(\d+)(?:\s|$|[.,!?])/);
  if (simpleMatch && defaultOwner && defaultRepo) {
    return {
      owner: defaultOwner,
      repo: defaultRepo,
      prNumber: parseInt(simpleMatch[1], 10),
    };
  }

  return null;
}

/**
 * Extract all PR references from a text message
 */
export function extractPRReferences(text: string, defaultOwner?: string, defaultRepo?: string): PRReference[] {
  const references: PRReference[] = [];
  const seen = new Set<string>();

  // Find all GitHub URLs
  const urlMatches = text.matchAll(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/g);
  for (const match of urlMatches) {
    const key = `${match[1]}/${match[2]}#${match[3]}`;
    if (!seen.has(key)) {
      seen.add(key);
      references.push({
        owner: match[1],
        repo: match[2],
        prNumber: parseInt(match[3], 10),
      });
    }
  }

  // Find all owner/repo#123 references
  const repoRefMatches = text.matchAll(/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)#(\d+)/g);
  for (const match of repoRefMatches) {
    const key = `${match[1]}/${match[2]}#${match[3]}`;
    if (!seen.has(key)) {
      seen.add(key);
      references.push({
        owner: match[1],
        repo: match[2],
        prNumber: parseInt(match[3], 10),
      });
    }
  }

  // Find simple #123 references (only if default repo is specified)
  if (defaultOwner && defaultRepo) {
    const simpleMatches = text.matchAll(/(^|[^\/])#(\d+)(?:\s|$|[.,!?])/g);
    for (const match of simpleMatches) {
      const key = `${defaultOwner}/${defaultRepo}#${match[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        references.push({
          owner: defaultOwner,
          repo: defaultRepo,
          prNumber: parseInt(match[2], 10),
        });
      }
    }
  }

  return references;
}
