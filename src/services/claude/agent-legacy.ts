import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { ClaudeAgentConfig, FixResult, CodeFix } from '../../types/index.js';
import fs from 'fs/promises';
import path from 'path';

/**
 * Claude Agent service for code analysis and fix generation
 *
 * This service:
 * 1. Gathers codebase context (package.json, README, file structure)
 * 2. Sends issue description + context to Claude
 * 3. Parses Claude's JSON response with fix instructions
 * 4. Applies file changes to the local repository
 */
class ClaudeAgentService {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({
      apiKey: config.claude.apiKey,
    });
  }

  /**
   * Analyze an issue and generate a fix
   *
   * @param issueDescription - User's description of the bug/feature
   * @param agentConfig - Configuration for the analysis
   * @returns Fix result with changes to apply
   */
  async analyzeAndFix(
    issueDescription: string,
    agentConfig: ClaudeAgentConfig
  ): Promise<FixResult> {
    try {
      logger.info('🤖 Starting Claude analysis', {
        issue: issueDescription.substring(0, 100),
        repo: agentConfig.repoPath,
      });

      // Step 1: Gather codebase context
      const context = await this.getCodebaseContext(agentConfig.repoPath);

      // Step 2: Build system prompt
      const systemPrompt = this.buildSystemPrompt(agentConfig, context);

      // Step 3: Call Claude API
      logger.debug('Calling Claude API...');
      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: agentConfig.maxTokens || 8000,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: `Issue to fix: ${issueDescription}\n\nPlease analyze this issue and provide a fix in the specified JSON format.`,
          },
        ],
      });

      // Step 4: Parse response
      const textContent = response.content.find((c) => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        throw new Error('No text content in Claude response');
      }

      logger.debug('Parsing Claude response...');
      const fixPlan = this.parseFixPlan(textContent.text);

      // Step 5: Apply changes to files
      logger.debug('Applying file changes...');
      const filesChanged = await this.applyFixes(fixPlan.fixes, agentConfig.repoPath);

      logger.success('Claude analysis complete', {
        filesChanged: filesChanged.length,
        analysis: fixPlan.analysis.substring(0, 100),
      });

      return {
        success: true,
        analysis: fixPlan.analysis,
        solution: fixPlan.solution,
        filesChanged,
        fixes: fixPlan.fixes,
      };
    } catch (error) {
      logger.error('❌ Claude analysis failed', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        analysis: 'Analysis failed',
        solution: '',
        filesChanged: [],
        fixes: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Build system prompt for Claude with instructions and context
   */
  private buildSystemPrompt(config: ClaudeAgentConfig, context: string): string {
    return `${config.systemPrompt}

You are analyzing a codebase to identify and fix issues.

CODEBASE LOCATION: ${config.repoPath}

CODEBASE CONTEXT:
${context}

INSTRUCTIONS:
1. Analyze the reported issue carefully and understand the root cause
2. Identify the specific files that need to be changed
3. Propose a minimal, focused fix that addresses the issue without breaking existing functionality
4. Provide COMPLETE new file contents (not diffs or patches)

RESPONSE FORMAT - You MUST respond with valid JSON in exactly this format:
{
  "analysis": "Clear explanation of what's wrong and why (2-3 sentences)",
  "solution": "Description of the fix you're applying (1-2 sentences)",
  "fixes": [
    {
      "path": "relative/path/from/repo/root/to/file.ts",
      "description": "Brief description of what you changed in this file",
      "newContent": "COMPLETE new file content with your changes applied"
    }
  ]
}

CRITICAL RULES:
- Only modify files that are directly related to fixing the issue
- Provide COMPLETE file content in newContent (not diffs, not partial content)
- Use relative paths from the repository root
- Be surgical - make minimal changes that fix the issue
- Maintain existing code style and formatting
- Do not add comments like "// Rest of file unchanged" - provide COMPLETE content
- If the file doesn't exist, newContent should contain the entire new file
- Test your logic mentally before responding

QUALITY CHECKLIST:
- Does this fix address the root cause?
- Will this break any existing functionality?
- Is the code maintainable and following best practices?
- Are there edge cases that need handling?

Remember: You are making real changes to a production codebase. Be thorough and careful.`;
  }

  /**
   * Gather codebase context for Claude
   */
  private async getCodebaseContext(repoPath: string): Promise<string> {
    const context: string[] = [];

    try {
      // Read package.json
      try {
        const pkgPath = path.join(repoPath, 'package.json');
        const pkg = await fs.readFile(pkgPath, 'utf-8');
        const pkgJson = JSON.parse(pkg);
        context.push(`=== package.json ===`);
        context.push(`Name: ${pkgJson.name || 'N/A'}`);
        context.push(`Description: ${pkgJson.description || 'N/A'}`);
        context.push(`Dependencies: ${Object.keys(pkgJson.dependencies || {}).join(', ')}`);
        context.push('');
      } catch {
        logger.warn('No package.json found');
      }

      // List top-level directory structure
      try {
        const files = await fs.readdir(repoPath);
        const filteredFiles = files.filter(
          (f) => !f.startsWith('.') && f !== 'node_modules'
        );
        context.push(`=== Repository Structure ===`);
        context.push(filteredFiles.join(', '));
        context.push('');
      } catch {
        logger.warn('Could not read directory structure');
      }

      // Read README if exists
      try {
        const readmePath = path.join(repoPath, 'README.md');
        const readme = await fs.readFile(readmePath, 'utf-8');
        const preview = readme.substring(0, 1500); // First 1500 chars
        context.push(`=== README.md (preview) ===`);
        context.push(preview);
        if (readme.length > 1500) {
          context.push('...(truncated)');
        }
        context.push('');
      } catch {
        // README optional
      }

      return context.join('\n');
    } catch (error) {
      logger.warn('Could not gather full codebase context', { error });
      return 'Codebase context unavailable';
    }
  }

  /**
   * Parse Claude's response into structured fix plan
   */
  private parseFixPlan(responseText: string): {
    analysis: string;
    solution: string;
    fixes: CodeFix[];
  } {
    try {
      // Try to extract JSON from response (Claude might wrap it in markdown)
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);

      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          analysis: parsed.analysis || 'No analysis provided',
          solution: parsed.solution || 'No solution provided',
          fixes: Array.isArray(parsed.fixes) ? parsed.fixes : [],
        };
      }

      // Fallback: treat entire response as analysis
      logger.warn('Could not parse JSON from Claude response, using raw text');
      return {
        analysis: responseText,
        solution: 'See analysis above',
        fixes: [],
      };
    } catch (error) {
      logger.warn('Failed to parse fix plan', { error });
      return {
        analysis: responseText,
        solution: 'Parse error',
        fixes: [],
      };
    }
  }

  /**
   * Apply code fixes to files
   */
  private async applyFixes(fixes: CodeFix[], repoPath: string): Promise<string[]> {
    const changed: string[] = [];

    for (const fix of fixes) {
      if (!fix.newContent) {
        logger.warn('Skipping fix with no content', { path: fix.path });
        continue;
      }

      try {
        const fullPath = path.join(repoPath, fix.path);

        // Backup original content if file exists
        try {
          fix.originalContent = await fs.readFile(fullPath, 'utf-8');
          logger.debug('Backed up original file', { path: fix.path });
        } catch {
          // New file - no original content
          logger.debug('Creating new file', { path: fix.path });
        }

        // Ensure directory exists
        const dir = path.dirname(fullPath);
        await fs.mkdir(dir, { recursive: true });

        // Write new content
        await fs.writeFile(fullPath, fix.newContent, 'utf-8');

        changed.push(fix.path);
        logger.info('📝 Applied fix', {
          path: fix.path,
          size: fix.newContent.length,
        });
      } catch (error) {
        logger.error('Failed to apply fix', {
          path: fix.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return changed;
  }
}

// Export singleton instance
export const claudeAgentService = new ClaudeAgentService();
