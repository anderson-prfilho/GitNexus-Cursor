/**
 * Cursor CLI Client for Wiki Generation
 *
 * Wrapper for the Cursor headless CLI (`agent` command).
 * Uses print mode for non-interactive LLM calls.
 *
 * Docs: https://cursor.com/docs/cli/headless
 */

import { spawn, execSync } from 'child_process';
import type { LLMResponse, CallLLMOptions } from './llm-client.js';

export interface CursorConfig {
  model?: string;
  workingDirectory?: string;
}

function isVerbose(): boolean {
  return process.env.GITNEXUS_VERBOSE === '1';
}

function verboseLog(...args: unknown[]): void {
  if (isVerbose()) {
    console.log('[cursor-cli]', ...args);
  }
}

let cachedCursorBin: string | null | undefined;

/**
 * Detect if Cursor CLI is available in PATH.
 * Returns the binary name if found ('agent'), null otherwise.
 * Result is cached after the first call.
 */
export function detectCursorCLI(): string | null {
  if (cachedCursorBin !== undefined) return cachedCursorBin;
  try {
    execSync('agent --version', { stdio: 'ignore' });
    cachedCursorBin = 'agent';
  } catch {
    cachedCursorBin = null;
  }
  return cachedCursorBin;
}

/**
 * Resolve Cursor CLI configuration.
 * Model is optional - if not provided, Cursor CLI uses its default (auto).
 */
export function resolveCursorConfig(overrides?: Partial<CursorConfig>): CursorConfig {
  return {
    model: overrides?.model,
    workingDirectory: overrides?.workingDirectory,
  };
}

/**
 * Call the Cursor CLI in print mode.
 *
 * Uses `agent -p --output-format text` for clean non-streaming output.
 * The prompt is passed as the final CLI argument.
 */
export async function callCursorLLM(
  prompt: string,
  config: CursorConfig,
  systemPrompt?: string,
  options?: CallLLMOptions,
): Promise<LLMResponse> {
  const cursorBin = detectCursorCLI();
  if (!cursorBin) {
    throw new Error(
      'Cursor CLI not found. Install it from https://cursor.com/docs/cli/installation',
    );
  }

  // Always use text format to get clean output without agent narration/thinking.
  // stream-json captures assistant messages which include "Let me explore..." narration
  // that pollutes the actual content when using thinking models.
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;

  const isWin = process.platform === 'win32';

  const args = ['-p', '--output-format', 'text', '--trust'];

  if (config.model) {
    args.push('--model', config.model);
  }

  // On Windows, the prompt is sent via stdin to avoid cmd.exe's 8191-char limit.
  // On other platforms, it's passed as the final CLI argument.
  if (!isWin) {
    args.push(fullPrompt);
  }

  verboseLog(
    'Spawning:',
    cursorBin,
    args.join(' '),
    '[prompt length:',
    fullPrompt.length,
    'chars]',
  );
  verboseLog('Working directory:', config.workingDirectory || process.cwd());
  verboseLog('Platform:', process.platform, isWin ? '(stdin mode)' : '(arg mode)');
  if (config.model) {
    verboseLog('Model:', config.model);
  } else {
    verboseLog('Model: auto (default)');
  }

  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    // On Windows: build a single command string with chcp for UTF-8 to avoid
    // DEP0190 warning and code page issues with accented characters.
    const spawnCmd = isWin
      ? `chcp 65001 >nul && ${cursorBin} ${args.join(' ')}`
      : cursorBin;
    const spawnArgs = isWin ? [] : args;

    const child = spawn(spawnCmd, spawnArgs, {
      cwd: config.workingDirectory || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWin,
      env: {
        ...process.env,
        CI: '1',
      },
    });

    verboseLog('Process spawned with PID:', child.pid);

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      verboseLog(`[stdout] received ${chunk.length} chars, total: ${stdout.length}`);

      if (options?.onChunk) {
        options.onChunk(stdout.length);
      }
    });

    child.on('close', (code) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      verboseLog(`Process exited with code ${code} after ${elapsed}s`);
      verboseLog(`stdout length: ${stdout.length} chars`);

      if (code !== 0) {
        verboseLog('stderr:', stderr);
        reject(new Error(`Cursor CLI exited with code ${code}: ${stderr}`));
        return;
      }
      resolve({ content: stdout.trim() });
    });

    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      verboseLog('[stderr]', chunk.trim());
    });

    child.on('error', (err) => {
      verboseLog('Spawn error:', err.message);
      reject(new Error(`Failed to spawn Cursor CLI: ${err.message}`));
    });

    if (isWin) {
      child.stdin.write(fullPrompt, 'utf8');
    }
    child.stdin.end();
  });
}
