#!/usr/bin/env node
/**
 * GitNexus Codex Hook
 *
 * PostToolUse — intercepts Bash results to:
 *   1. Augment search results (rg/grep) with graph context from the GitNexus index
 *   2. Detect stale index after git mutations and notify the agent
 *
 * Wire format (Codex):
 *   stdin  → JSON { hook_event_name, tool_name, tool_input, tool_response?, cwd, ... }
 *   stdout → JSON { hookSpecificOutput: { hookEventName, additionalContext } }
 *
 * Why PostToolUse only:
 *   - `additionalContext` on `PreToolUse` is parsed but not implemented yet ("fail open"
 *     per Codex docs), so it does not feed the model.
 *   - `SessionStart` only fires once per session; AGENTS.md already covers that case.
 *   - PostToolUse is the documented channel where `additionalContext` is actually
 *     surfaced to the model as extra developer context.
 *
 * Cross-platform: works on Windows without bash or jq.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const STDIN_TIMEOUT = setTimeout(() => process.exit(0), 8000);

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
 * Walk up from startDir looking for a non-registry .gitnexus/ directory.
 * The global registry (~/.gitnexus) contains repos/ + registry.json but no
 * per-repo meta.json — skip it so we always resolve to the project index.
 */
function findGitNexusDir(startDir) {
  let dir = startDir || process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.gitnexus');
    if (fs.existsSync(candidate)) {
      const hasMeta = fs.existsSync(path.join(candidate, 'meta.json'));
      const isRegistry =
        !hasMeta &&
        (fs.existsSync(path.join(candidate, 'registry.json')) ||
          fs.existsSync(path.join(candidate, 'repos')));
      if (!isRegistry) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the gitnexus CLI path.
 * 1. Path baked in by the installer (replaced at install-time by setup.ts).
 * 2. Relative path inside the npm package layout (dev / non-installed runs).
 * 3. require.resolve fallback (works when gitnexus is globally installed).
 * 4. Empty string → run via `npx -y gitnexus`.
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
 * Spawn a gitnexus CLI command synchronously.
 * Returns the spawn result; callers must check `status === 0` AND `stderr`
 * because `augment` writes its payload to stderr (LadybugDB takes stdout at
 * the OS level).
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
 * Extract a search term from a Bash command using rg/grep.
 * Skips flag values (-e, -A, -B, --glob, etc.) so the agent's query stays
 * the pattern token, not the flag argument.
 */
function extractBashSearchPattern(command) {
  if (!/\brg\b|\bgrep\b/.test(command)) return null;

  const tokens = command.split(/\s+/);
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

  let foundCmd = false;
  let skipNext = false;
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

function handleAugmentation(input, cwd) {
  if ((input.tool_name || '') !== 'Bash') return null;

  const command = (input.tool_input || {}).command || '';
  const pattern = extractBashSearchPattern(command);
  if (!pattern || pattern.length < 3) return null;

  const cliPath = resolveCliPath();
  try {
    const child = runGitNexusCli(cliPath, ['augment', '--', pattern], cwd, 7000);
    if (!child.error && child.status === 0) {
      const result = (child.stderr || '').trim();
      if (result) return result;
    }
  } catch {
    /* graceful failure */
  }
  return null;
}

/**
 * Codex sends Bash output in `tool_response` (PostToolUse). Older shapes may
 * carry an `exit_code` field; if missing, assume success.
 */
function readExitCode(input) {
  const resp = input.tool_response;
  if (resp && typeof resp === 'object' && typeof resp.exit_code === 'number') {
    return resp.exit_code;
  }
  if (resp && typeof resp === 'string') {
    try {
      const parsed = JSON.parse(resp);
      if (parsed && typeof parsed.exit_code === 'number') return parsed.exit_code;
    } catch {
      /* not JSON */
    }
  }
  const out = input.tool_output;
  if (out && typeof out === 'object' && typeof out.exit_code === 'number') {
    return out.exit_code;
  }
  return undefined;
}

function handleStaleness(input, cwd, gitNexusDir) {
  if ((input.tool_name || '') !== 'Bash') return null;

  const command = (input.tool_input || {}).command || '';
  if (!/\bgit\s+(commit|merge|rebase|cherry-pick|pull)(\s|$)/.test(command)) return null;

  const exitCode = readExitCode(input);
  if (exitCode !== undefined && exitCode !== 0) return null;

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
  let hadEmbeddings = false;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(gitNexusDir, 'meta.json'), 'utf-8'));
    lastCommit = meta.lastCommit || '';
    hadEmbeddings = !!(meta.stats && meta.stats.embeddings > 0);
  } catch {
    /* no meta — treat as stale */
  }

  if (currentHead && currentHead === lastCommit) return null;

  const analyzeCmd = `npx gitnexus analyze${hadEmbeddings ? ' --embeddings' : ''}`;
  return (
    `GitNexus index is stale (last indexed: ${lastCommit ? lastCommit.slice(0, 7) : 'never'}). ` +
    `Run \`${analyzeCmd}\` to update the knowledge graph.`
  );
}

function sendAdditionalContext(eventName, message) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: message,
    },
  };
  console.log(JSON.stringify(payload));
}

function handlePostToolUse(input) {
  const cwd = input.cwd || process.cwd();
  if (!path.isAbsolute(cwd)) return;

  const gitNexusDir = findGitNexusDir(cwd);
  if (!gitNexusDir) return;

  const augmentResult = handleAugmentation(input, cwd);
  const stalenessResult = handleStaleness(input, cwd, gitNexusDir);

  const parts = [augmentResult, stalenessResult].filter(Boolean);
  if (parts.length > 0) {
    sendAdditionalContext('PostToolUse', parts.join('\n\n'));
  }
}

const handlers = {
  PostToolUse: handlePostToolUse,
};

function main() {
  try {
    const input = readInput();
    const handler = handlers[input.hook_event_name || ''];
    if (handler) handler(input);
  } catch (err) {
    if (process.env.GITNEXUS_DEBUG) {
      console.error('GitNexus hook error:', (err.message || '').slice(0, 200));
    }
  }
}

main();
