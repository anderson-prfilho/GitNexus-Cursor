#!/usr/bin/env node
/**
 * GitNexus Cursor Hook
 *
 * postToolUse — intercepts Shell and Grep results to:
 *   1. Augment search results with graph context from the GitNexus index
 *   2. Detect stale index after git mutations and notify the agent
 *
 * Output format: { "additional_context": "..." } (Cursor convention)
 *
 * Cross-platform: works on Windows without bash or jq.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Kill the process if stdin hangs (subagent contexts may not close stdin).
const STDIN_TIMEOUT = setTimeout(() => process.exit(0), 8000);

/**
 * Read JSON input from stdin synchronously.
 */
function readInput() {
  try {
    const data = fs.readFileSync(0, 'utf-8').replace(/^\uFEFF/, '');
    clearTimeout(STDIN_TIMEOUT);
    return JSON.parse(data);
  } catch {
    clearTimeout(STDIN_TIMEOUT);
    return {};
  }
}

/**
 * Find the .gitnexus directory by walking up from startDir.
 * Returns the path to .gitnexus/ or null if not found.
 */
function findGitNexusDir(startDir) {
  let dir = startDir || process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.gitnexus');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the gitnexus CLI path.
 * 1. Relative path (works when script is inside npm package)
 * 2. require.resolve (works when gitnexus is globally installed)
 * 3. Fall back to npx (returns empty string)
 */
function resolveCliPath() {
  let cliPath = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');
  if (!fs.existsSync(cliPath)) {
    try {
      cliPath = require.resolve('gitnexus/dist/cli/index.js');
    } catch {
      cliPath = '';
    }
  }
  return cliPath;
}

/**
 * Send a Cursor-format response with additional context.
 */
function sendResponse(message) {
  console.log(JSON.stringify({ additional_context: message }));
}

/**
 * Extract search pattern from tool input.
 * Handles Cursor's Grep (tool_input.pattern) and Shell (rg/grep commands).
 */
function extractPattern(toolName, toolInput) {
  if (toolName === 'Grep') {
    const raw = toolInput.pattern || '';
    if (!raw) return null;
    // Grep patterns are regex — extract meaningful terms.
    // 1. Split on | (alternation)
    // 2. Replace regex metacharacters with space (avoid word concatenation)
    // 3. Split on whitespace, strip prefixes like "def ", pick the best term
    const terms = raw.split('|')
      .flatMap(t => t.replace(/\\[bBdDwWsS]|[.*+?^${}()\[\]\\=]/g, ' ').trim().split(/\s+/))
      .map(t => t.replace(/^def$/, '').replace(/^(def|class|function|import|from|return)\s*/i, '').trim())
      .filter(t => t.length >= 3 && !/^(def|class|function|import|from|return|const|let|var)$/i.test(t));
    if (terms.length === 0) return null;
    terms.sort((a, b) => b.length - a.length);
    return terms[0];
  }

  if (toolName === 'Shell') {
    const cmd = toolInput.command || '';
    if (!/\brg\b|\bgrep\b/.test(cmd)) return null;

    const tokens = cmd.split(/\s+/);
    let foundCmd = false;
    let skipNext = false;
    const flagsWithValues = new Set([
      '-e',
      '-f',
      '-m',
      '-A',
      '-B',
      '-C',
      '-g',
      '--glob',
      '-t',
      '--type',
      '--include',
      '--exclude',
    ]);

    for (const token of tokens) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (!foundCmd) {
        if (/\brg$|\bgrep$/.test(token)) foundCmd = true;
        continue;
      }
      if (token.startsWith('-')) {
        if (flagsWithValues.has(token)) skipNext = true;
        continue;
      }
      const cleaned = token.replace(/['"]/g, '');
      return cleaned.length >= 3 ? cleaned : null;
    }
    return null;
  }

  return null;
}

/**
 * Spawn a gitnexus CLI command synchronously.
 * Returns the stderr output (LadybugDB captures stdout at OS level).
 */
function runGitNexusCli(cliPath, args, cwd, timeout) {
  const isWin = process.platform === 'win32';
  if (cliPath) {
    return spawnSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf-8',
      timeout,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }
  return spawnSync(isWin ? 'npx.cmd' : 'npx', ['-y', 'gitnexus', ...args], {
    encoding: 'utf-8',
    timeout: timeout + 5000,
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Handle augmentation: enrich search results with graph context.
 * Triggers for Grep or Shell commands containing rg/grep.
 */
function handleAugmentation(input, cwd) {
  const toolName = input.tool_name || '';
  const toolInput = input.tool_input || {};

  if (toolName !== 'Grep' && toolName !== 'Shell') return null;

  const pattern = extractPattern(toolName, toolInput);
  if (!pattern || pattern.length < 3) return null;

  const cliPath = resolveCliPath();
  try {
    const child = runGitNexusCli(cliPath, ['augment', '--', pattern], cwd, 7000);
    if (!child.error && child.status === 0) {
      const result = child.stderr || '';
      if (result.trim()) return result.trim();
    }
  } catch {
    /* graceful failure */
  }

  return null;
}

/**
 * Handle staleness detection: check if index is outdated after git mutations.
 * Triggers for Shell commands containing git commit/merge/rebase/cherry-pick/pull.
 */
function handleStaleness(input, cwd, gitNexusDir) {
  const toolName = input.tool_name || '';
  if (toolName !== 'Shell') return null;

  const command = (input.tool_input || {}).command || '';
  if (!/\bgit\s+(commit|merge|rebase|cherry-pick|pull)(\s|$)/.test(command)) return null;

  const toolOutput = parseToolOutput(input.tool_output);
  if (toolOutput.exit_code !== undefined && toolOutput.exit_code !== 0) return null;

  let currentHead = '';
  try {
    const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 3000,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    currentHead = (headResult.stdout || '').trim();
  } catch {
    return null;
  }

  if (!currentHead) return null;

  let lastCommit = '';
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(gitNexusDir, 'meta.json'), 'utf-8'));
    lastCommit = meta.lastCommit || '';
  } catch {
    /* no meta — treat as stale */
  }

  if (currentHead && currentHead === lastCommit) return null;

  return (
    `GitNexus index is stale (last indexed: ${lastCommit ? lastCommit.slice(0, 7) : 'never'}). ` +
    'Run `gitnexus analyze -f --embeddings --skills -v` to update the knowledge graph.'
  );
}

/**
 * Resolve the working directory from Cursor's input.
 * Cursor sends workspace_roots (array of URI-style paths like "/C:/Users/...").
 * On Windows, strip the leading "/" from drive-letter paths.
 */
function resolveCwd(input) {
  if (input.cwd) return input.cwd;

  const roots = input.workspace_roots;
  if (Array.isArray(roots) && roots.length > 0) {
    let root = roots[0];
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(root)) {
      root = root.slice(1);
    }
    return root.replace(/\//g, path.sep);
  }

  return process.cwd();
}

/**
 * Parse tool_output which Cursor sends as a JSON string, not an object.
 */
function parseToolOutput(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * postToolUse handler — combines augmentation and staleness detection.
 */
function handlePostToolUse(input) {
  const cwd = resolveCwd(input);
  if (!path.isAbsolute(cwd)) return;

  const gitNexusDir = findGitNexusDir(cwd);
  if (!gitNexusDir) return;

  const augmentResult = handleAugmentation(input, cwd);
  const stalenessResult = handleStaleness(input, cwd, gitNexusDir);

  const parts = [augmentResult, stalenessResult].filter(Boolean);
  if (parts.length > 0) {
    sendResponse(parts.join('\n\n'));
  }
}

// Dispatch map for hook events
const handlers = {
  postToolUse: handlePostToolUse,
};

function main() {
  try {
    const input = readInput();
    const eventName = input.hook_event_name || '';
    const handler = handlers[eventName];
    if (handler) handler(input);
  } catch (err) {
    if (process.env.GITNEXUS_DEBUG) {
      console.error('GitNexus hook error:', (err.message || '').slice(0, 200));
    }
  }
}

main();
