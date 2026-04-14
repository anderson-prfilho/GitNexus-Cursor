/**
 * Unit Tests: Cursor Hooks
 *
 * Tests the Cursor hook script (gitnexus-hook.cjs) that runs as a
 * postToolUse hook in Cursor.
 *
 * Covers:
 * - Output format: { additional_context } (Cursor convention)
 * - extractPattern: pattern extraction from Grep/Shell tool inputs
 * - Dispatch: postToolUse event routing
 * - Graceful failure: invalid JSON, empty stdin, unknown events
 * - Shell injection: no shell: true in spawnSync calls
 * - Windows: .cmd extension handling
 * - Staleness detection: meta.json comparison with HEAD
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runHook, parseCursorHookOutput } from '../utils/hook-test-helpers.js';

const CURSOR_HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'cursor', 'gitnexus-hook.cjs');

let tmpDir: string;
let gitNexusDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-hook-test-'));
  gitNexusDir = path.join(tmpDir, '.gitnexus');
  fs.mkdirSync(gitNexusDir, { recursive: true });

  spawnSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' });
  fs.writeFileSync(path.join(tmpDir, 'dummy.txt'), 'hello');
  spawnSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function getHeadCommit(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: tmpDir,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return (result.stdout || '').trim();
}

// ─── Hook file existence ────────────────────────────────────────────

const INTEGRATION_HOOK = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'gitnexus-cursor-integration',
  'hooks',
  'gitnexus-hook.cjs',
);

describe('Hook file exists', () => {
  it('Cursor hook exists', () => {
    expect(fs.existsSync(CURSOR_HOOK)).toBe(true);
  });
});

// ─── Anti-drift: integration copy must match main hook ──────────────

describe('Integration copy sync', () => {
  it('gitnexus-cursor-integration hook is identical to main hook', () => {
    if (!fs.existsSync(INTEGRATION_HOOK)) return;
    const main = fs.readFileSync(CURSOR_HOOK, 'utf-8');
    const copy = fs.readFileSync(INTEGRATION_HOOK, 'utf-8');
    expect(copy).toBe(main);
  });
});

// ─── Output format: Cursor convention ───────────────────────────────

describe('Output format', () => {
  it('uses { additional_context } format (not hookSpecificOutput)', () => {
    const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
    expect(source).toContain('additional_context');
    expect(source).not.toContain('hookSpecificOutput');
  });

  it('sendResponse produces flat JSON with additional_context key', () => {
    const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
    expect(source).toContain("JSON.stringify({ additional_context: message })");
  });
});

// ─── Shell injection regression: no shell: true ─────────────────────

describe('Shell injection regression', () => {
  it('has no shell: true in spawnSync calls', () => {
    const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      if (/shell:\s*(true|isWin)/.test(line)) {
        throw new Error(`Cursor hook line ${i + 1} has shell injection risk: ${line.trim()}`);
      }
    }
  });
});

// ─── Windows .cmd extension handling ────────────────────────────────

describe('Windows .cmd extension handling', () => {
  it('uses .cmd extensions for Windows npx', () => {
    const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
    expect(source).toContain('npx.cmd');
  });
});

// ─── cwd validation ────────────────────────────────────────────────

describe('cwd validation', () => {
  it('validates cwd is absolute path', () => {
    const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
    expect(source).toContain('path.isAbsolute(cwd)');
  });

  it('silent when cwd is relative', () => {
    const result = runHook(CURSOR_HOOK, {
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'git commit -m "test"' },
      tool_output: { exit_code: 0 },
      cwd: 'relative/path',
    });
    expect(result.stdout.trim()).toBe('');
  });
});

// ─── extractPattern coverage ────────────────────────────────────────

describe('extractPattern coverage', () => {
  it('handles Grep tool_input.pattern', () => {
    const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
    expect(source).toContain("toolName === 'Grep'");
    expect(source).toContain('toolInput.pattern');
  });

  it('handles Shell with rg/grep commands', () => {
    const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
    expect(source).toContain("toolName === 'Shell'");
    expect(source).toMatch(/\\brg\\b.*\\bgrep\\b/);
  });

  it('uses Shell instead of Bash (Cursor convention)', () => {
    const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
    expect(source).not.toContain("toolName === 'Bash'");
  });

  it('rejects patterns shorter than 3 chars', () => {
    const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
    expect(source).toContain('cleaned.length >= 3');
  });
});

// ─── Dispatch map ───────────────────────────────────────────────────

describe('Dispatch map', () => {
  it('uses dispatch map for event routing', () => {
    const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
    expect(source).toContain('const handlers = {');
    expect(source).toContain('postToolUse: handlePostToolUse');
  });

  it('reads event from input.hook_event_name field', () => {
    const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
    expect(source).toContain("input.hook_event_name || ''");
  });

  it('unknown event produces no output', () => {
    const result = runHook(CURSOR_HOOK, {
      hook_event_name: 'unknownEvent',
      tool_name: 'Shell',
      tool_input: { command: 'echo hello' },
      cwd: tmpDir,
    });
    expect(result.stdout.trim()).toBe('');
    expect(result.status).toBe(0);
  });

  it('empty event produces no output', () => {
    const result = runHook(CURSOR_HOOK, {
      hook_event_name: '',
      tool_name: 'Shell',
      cwd: tmpDir,
    });
    expect(result.stdout.trim()).toBe('');
    expect(result.status).toBe(0);
  });

  it('missing event produces no output', () => {
    const result = runHook(CURSOR_HOOK, {
      tool_name: 'Shell',
      cwd: tmpDir,
    });
    expect(result.stdout.trim()).toBe('');
    expect(result.status).toBe(0);
  });
});

// ─── Graceful failure ───────────────────────────────────────────────

describe('Graceful failure', () => {
  it('invalid JSON input exits cleanly', () => {
    const result = spawnSync(process.execPath, [CURSOR_HOOK], {
      input: 'not json at all',
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('empty stdin exits cleanly', () => {
    const result = spawnSync(process.execPath, [CURSOR_HOOK], {
      input: '',
      encoding: 'utf-8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(result.status).toBe(0);
  });

  it('truncates error messages to 200 chars', () => {
    const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
    expect(source).toContain('.slice(0, 200)');
  });
});

// ─── Git mutation regex coverage ────────────────────────────────────

describe('Git mutation regex', () => {
  it('detects git commit', () => {
    const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
    expect(source).toMatch(/commit\|merge\|rebase\|cherry-pick\|pull/);
  });

  for (const mutation of ['commit', 'merge', 'rebase', 'cherry-pick', 'pull']) {
    it(`detects git ${mutation}`, () => {
      const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
      expect(source).toContain(mutation);
    });
  }
});

// ─── PostToolUse staleness detection ────────────────────────────────

describe('PostToolUse staleness detection', () => {
  it('emits stale notification when HEAD differs from meta', () => {
    fs.writeFileSync(
      path.join(gitNexusDir, 'meta.json'),
      JSON.stringify({ lastCommit: 'aaaaaaa0000000000000000000000000deadbeef', stats: {} }),
    );

    const result = runHook(CURSOR_HOOK, {
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'git commit -m "test"' },
      tool_output: { exit_code: 0 },
      cwd: tmpDir,
    });

    const ctx = parseCursorHookOutput(result.stdout);
    expect(ctx).not.toBeNull();
    expect(ctx).toContain('stale');
    expect(ctx).toContain('aaaaaaa');
  });

  it('silent when HEAD matches meta lastCommit', () => {
    const head = getHeadCommit();
    fs.writeFileSync(
      path.join(gitNexusDir, 'meta.json'),
      JSON.stringify({ lastCommit: head, stats: {} }),
    );

    const result = runHook(CURSOR_HOOK, {
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'git commit -m "test"' },
      tool_output: { exit_code: 0 },
      cwd: tmpDir,
    });

    expect(result.stdout.trim()).toBe('');
  });

  it('silent when tool is not Shell', () => {
    const result = runHook(CURSOR_HOOK, {
      hook_event_name: 'postToolUse',
      tool_name: 'Read',
      tool_input: { command: 'git commit -m "test"' },
      cwd: tmpDir,
    });
    expect(result.stdout.trim()).toBe('');
  });

  it('silent when command is not a git mutation', () => {
    const result = runHook(CURSOR_HOOK, {
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'git status' },
      tool_output: { exit_code: 0 },
      cwd: tmpDir,
    });
    expect(result.stdout.trim()).toBe('');
  });

  it('silent when exit code is non-zero', () => {
    const result = runHook(CURSOR_HOOK, {
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'git commit -m "fail"' },
      tool_output: { exit_code: 1 },
      cwd: tmpDir,
    });
    expect(result.stdout.trim()).toBe('');
  });

  it('uses fixed analyze command with -f --embeddings --skills -v', () => {
    fs.writeFileSync(
      path.join(gitNexusDir, 'meta.json'),
      JSON.stringify({ lastCommit: 'deadbeef', stats: {} }),
    );

    const result = runHook(CURSOR_HOOK, {
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'git merge feature' },
      tool_output: { exit_code: 0 },
      cwd: tmpDir,
    });

    const ctx = parseCursorHookOutput(result.stdout);
    expect(ctx).not.toBeNull();
    expect(ctx).toContain('gitnexus analyze -f --embeddings --skills -v');
  });

  it('emits stale when meta.json does not exist', () => {
    const metaPath = path.join(gitNexusDir, 'meta.json');
    if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

    try {
      const result = runHook(CURSOR_HOOK, {
        hook_event_name: 'postToolUse',
        tool_name: 'Shell',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      const ctx = parseCursorHookOutput(result.stdout);
      expect(ctx).not.toBeNull();
      expect(ctx).toContain('never');
    } finally {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'old', stats: {} }),
      );
    }
  });

  it('emits stale when meta.json is corrupt', () => {
    const metaPath = path.join(gitNexusDir, 'meta.json');
    fs.writeFileSync(metaPath, 'not valid json!!!');

    const result = runHook(CURSOR_HOOK, {
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'git commit -m "test"' },
      tool_output: { exit_code: 0 },
      cwd: tmpDir,
    });

    const ctx = parseCursorHookOutput(result.stdout);
    expect(ctx).not.toBeNull();
    expect(ctx).toContain('never');

    fs.writeFileSync(metaPath, JSON.stringify({ lastCommit: 'old', stats: {} }));
  });

  it('detects git rebase as a mutation', () => {
    fs.writeFileSync(
      path.join(gitNexusDir, 'meta.json'),
      JSON.stringify({ lastCommit: 'oldcommit', stats: {} }),
    );

    const result = runHook(CURSOR_HOOK, {
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'git rebase main' },
      tool_output: { exit_code: 0 },
      cwd: tmpDir,
    });

    const ctx = parseCursorHookOutput(result.stdout);
    expect(ctx).not.toBeNull();
    expect(ctx).toContain('stale');
  });

  it('detects git cherry-pick as a mutation', () => {
    fs.writeFileSync(
      path.join(gitNexusDir, 'meta.json'),
      JSON.stringify({ lastCommit: 'oldcommit', stats: {} }),
    );

    const result = runHook(CURSOR_HOOK, {
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'git cherry-pick abc123' },
      tool_output: { exit_code: 0 },
      cwd: tmpDir,
    });

    const ctx = parseCursorHookOutput(result.stdout);
    expect(ctx).not.toBeNull();
  });

  it('detects git pull as a mutation', () => {
    fs.writeFileSync(
      path.join(gitNexusDir, 'meta.json'),
      JSON.stringify({ lastCommit: 'oldcommit', stats: {} }),
    );

    const result = runHook(CURSOR_HOOK, {
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'git pull origin main' },
      tool_output: { exit_code: 0 },
      cwd: tmpDir,
    });

    const ctx = parseCursorHookOutput(result.stdout);
    expect(ctx).not.toBeNull();
  });

  it('handles tool_output as JSON string (real Cursor format)', () => {
    fs.writeFileSync(
      path.join(gitNexusDir, 'meta.json'),
      JSON.stringify({ lastCommit: 'oldcommit', stats: {} }),
    );

    const result = runHook(CURSOR_HOOK, {
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'git commit -m "test"' },
      tool_output: '{"exit_code": 0}',
      cwd: tmpDir,
    });

    const ctx = parseCursorHookOutput(result.stdout);
    expect(ctx).not.toBeNull();
    expect(ctx).toContain('stale');
  });

  it('silent when tool_output string has non-zero exit_code', () => {
    fs.writeFileSync(
      path.join(gitNexusDir, 'meta.json'),
      JSON.stringify({ lastCommit: 'oldcommit', stats: {} }),
    );

    const result = runHook(CURSOR_HOOK, {
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'git commit -m "fail"' },
      tool_output: '{"exit_code": 1}',
      cwd: tmpDir,
    });

    expect(result.stdout.trim()).toBe('');
  });
});

// ─── Cursor real input format (workspace_roots) ─────────────────────

describe('workspace_roots resolution', () => {
  it('resolves cwd from workspace_roots when cwd is absent', () => {
    fs.writeFileSync(
      path.join(gitNexusDir, 'meta.json'),
      JSON.stringify({ lastCommit: 'oldcommit', stats: {} }),
    );

    const result = runHook(CURSOR_HOOK, {
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'git commit -m "test"' },
      tool_output: '{"exit_code": 0}',
      workspace_roots: [tmpDir.replace(/\\/g, '/')],
    });

    const ctx = parseCursorHookOutput(result.stdout);
    expect(ctx).not.toBeNull();
    expect(ctx).toContain('stale');
  });

  it('prefers cwd over workspace_roots when both present', () => {
    fs.writeFileSync(
      path.join(gitNexusDir, 'meta.json'),
      JSON.stringify({ lastCommit: 'oldcommit', stats: {} }),
    );

    const result = runHook(CURSOR_HOOK, {
      hook_event_name: 'postToolUse',
      tool_name: 'Shell',
      tool_input: { command: 'git commit -m "test"' },
      tool_output: '{"exit_code": 0}',
      cwd: tmpDir,
      workspace_roots: ['/nonexistent/path'],
    });

    const ctx = parseCursorHookOutput(result.stdout);
    expect(ctx).not.toBeNull();
    expect(ctx).toContain('stale');
  });

  it('handles workspace_roots with Windows URI prefix /C:', () => {
    const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
    expect(source).toContain("root.slice(1)");
    expect(source).toMatch(/\/\[A-Za-z\]:/);
  });

  it('falls back to process.cwd() when neither cwd nor workspace_roots present', () => {
    const source = fs.readFileSync(CURSOR_HOOK, 'utf-8');
    expect(source).toContain('return process.cwd()');
  });
});
