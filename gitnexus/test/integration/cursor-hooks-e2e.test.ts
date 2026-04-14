/**
 * Integration Tests: Cursor Hooks End-to-End
 *
 * Tests the Cursor hook script with real git repos and .gitnexus directories.
 * Verifies actual behavior with filesystem state: staleness detection,
 * cwd validation, and repos without .gitnexus.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-hooks-e2e-'));
  gitNexusDir = path.join(tmpDir, '.gitnexus');
  fs.mkdirSync(gitNexusDir, { recursive: true });

  spawnSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' });

  fs.writeFileSync(path.join(tmpDir, 'hello.txt'), 'hello');
  spawnSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'pipe' });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Cursor hooks e2e', () => {
  describe('PostToolUse staleness detection', () => {
    it('detects stale index when meta.json lastCommit differs from HEAD', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stats: {} }),
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
      expect(ctx).toContain('gitnexus analyze');
    });

    it('stays silent when meta.json lastCommit matches HEAD', () => {
      const headResult = spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: tmpDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const head = headResult.stdout.trim();

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

      const ctx = parseCursorHookOutput(result.stdout);
      expect(ctx).toBeNull();
    });

    it('treats missing meta.json as stale', () => {
      const metaPath = path.join(gitNexusDir, 'meta.json');
      if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);

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
    });

    it('ignores failed git commands (exit_code !== 0)', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'cccccccccccccccccccccccccccccccccccccccc', stats: {} }),
      );

      const result = runHook(CURSOR_HOOK, {
        hook_event_name: 'postToolUse',
        tool_name: 'Shell',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 1 },
        cwd: tmpDir,
      });

      const ctx = parseCursorHookOutput(result.stdout);
      expect(ctx).toBeNull();
    });

    it('ignores non-mutation git commands', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'dddddddddddddddddddddddddddddddddddddddd', stats: {} }),
      );

      const nonMutations = ['git status', 'git log', 'git diff', 'git branch', 'git stash'];
      for (const cmd of nonMutations) {
        const result = runHook(CURSOR_HOOK, {
          hook_event_name: 'postToolUse',
          tool_name: 'Shell',
          tool_input: { command: cmd },
          tool_output: { exit_code: 0 },
          cwd: tmpDir,
        });
        const ctx = parseCursorHookOutput(result.stdout);
        expect(ctx).toBeNull();
      }
    });

    it('detects all 5 git mutation types', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', stats: {} }),
      );

      const mutations = [
        'git commit -m "x"',
        'git merge feature',
        'git rebase main',
        'git cherry-pick abc',
        'git pull origin main',
      ];
      for (const cmd of mutations) {
        const result = runHook(CURSOR_HOOK, {
          hook_event_name: 'postToolUse',
          tool_name: 'Shell',
          tool_input: { command: cmd },
          tool_output: { exit_code: 0 },
          cwd: tmpDir,
        });
        const ctx = parseCursorHookOutput(result.stdout);
        expect(ctx).not.toBeNull();
        expect(ctx).toContain('stale');
      }
    });
  });

  describe('postToolUse augmentation — silent without gitnexus CLI', () => {
    it('handles Grep pattern gracefully when CLI is unavailable', () => {
      const result = runHook(CURSOR_HOOK, {
        hook_event_name: 'postToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'handleRequest' },
        cwd: tmpDir,
      });

      expect(result.status === 0 || result.status === null).toBe(true);
    });

    it('ignores patterns shorter than 3 chars', () => {
      const result = runHook(CURSOR_HOOK, {
        hook_event_name: 'postToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'ab' },
        cwd: tmpDir,
      });

      expect(result.status).toBe(0);
      const ctx = parseCursorHookOutput(result.stdout);
      expect(ctx).toBeNull();
    });

    it('ignores non-search tools', () => {
      const result = runHook(CURSOR_HOOK, {
        hook_event_name: 'postToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/some/file.ts' },
        cwd: tmpDir,
      });

      expect(result.status).toBe(0);
      const ctx = parseCursorHookOutput(result.stdout);
      expect(ctx).toBeNull();
    });
  });

  describe('cwd validation', () => {
    it('rejects relative cwd silently for postToolUse', () => {
      const result = runHook(CURSOR_HOOK, {
        hook_event_name: 'postToolUse',
        tool_name: 'Shell',
        tool_input: { command: 'git commit -m "x"' },
        tool_output: { exit_code: 0 },
        cwd: 'relative/path',
      });

      const ctx = parseCursorHookOutput(result.stdout);
      expect(ctx).toBeNull();
    });
  });

  describe('unhappy paths', () => {
    it('handles corrupted meta.json without crashing', () => {
      fs.writeFileSync(path.join(gitNexusDir, 'meta.json'), 'THIS IS NOT JSON {{{');

      const result = runHook(CURSOR_HOOK, {
        hook_event_name: 'postToolUse',
        tool_name: 'Shell',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      expect(result.status === 0 || result.status === null).toBe(true);
    });

    it('handles meta.json with missing lastCommit field', () => {
      fs.writeFileSync(path.join(gitNexusDir, 'meta.json'), JSON.stringify({ stats: {} }));

      const result = runHook(CURSOR_HOOK, {
        hook_event_name: 'postToolUse',
        tool_name: 'Shell',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      expect(result.status === 0 || result.status === null).toBe(true);
      const ctx = parseCursorHookOutput(result.stdout);
      if (ctx) {
        expect(ctx).toContain('stale');
      }
    });

    it('ignores unknown event name', () => {
      const result = runHook(CURSOR_HOOK, {
        hook_event_name: 'unknownEvent',
        tool_name: 'Shell',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      expect(result.status).toBe(0);
      const ctx = parseCursorHookOutput(result.stdout);
      expect(ctx).toBeNull();
    });

    it('handles empty tool_input without crashing', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'aaaa', stats: {} }),
      );

      const result = runHook(CURSOR_HOOK, {
        hook_event_name: 'postToolUse',
        tool_name: 'Shell',
        tool_input: {},
        tool_output: { exit_code: 0 },
        cwd: tmpDir,
      });

      expect(result.status === 0 || result.status === null).toBe(true);
      const ctx = parseCursorHookOutput(result.stdout);
      expect(ctx).toBeNull();
    });

    it('ignores non-Shell tool for staleness detection', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'aaaa', stats: {} }),
      );

      const result = runHook(CURSOR_HOOK, {
        hook_event_name: 'postToolUse',
        tool_name: 'Read',
        tool_input: { file_path: '/some/file.ts' },
        tool_output: {},
        cwd: tmpDir,
      });

      expect(result.status).toBe(0);
      const ctx = parseCursorHookOutput(result.stdout);
      expect(ctx).toBeNull();
    });
  });

  describe('directory without .gitnexus', () => {
    let noGitNexusDir: string;

    beforeAll(() => {
      const root = os.platform() === 'win32' ? 'C:\\' : '/tmp';
      const base = path.join(root, `no-gitnexus-cursor-${Date.now()}`);
      noGitNexusDir = path.join(base, 'a', 'b', 'c', 'd', 'e', 'f');
      fs.mkdirSync(noGitNexusDir, { recursive: true });
      spawnSync('git', ['init'], { cwd: noGitNexusDir, stdio: 'pipe' });
    });

    afterAll(() => {
      const root = os.platform() === 'win32' ? 'C:\\' : '/tmp';
      const base = path.join(
        root,
        path.basename(path.resolve(noGitNexusDir, '..', '..', '..', '..', '..', '..')),
      );
      fs.rmSync(base, { recursive: true, force: true });
    });

    it('ignores postToolUse when no .gitnexus directory exists', () => {
      const result = runHook(CURSOR_HOOK, {
        hook_event_name: 'postToolUse',
        tool_name: 'Shell',
        tool_input: { command: 'git commit -m "x"' },
        tool_output: { exit_code: 0 },
        cwd: noGitNexusDir,
      });

      const ctx = parseCursorHookOutput(result.stdout);
      expect(ctx).toBeNull();
    });

    it('ignores Grep augmentation when no .gitnexus directory exists', () => {
      const result = runHook(CURSOR_HOOK, {
        hook_event_name: 'postToolUse',
        tool_name: 'Grep',
        tool_input: { pattern: 'somePattern' },
        cwd: noGitNexusDir,
      });

      const ctx = parseCursorHookOutput(result.stdout);
      expect(ctx).toBeNull();
    });
  });

  describe('Real Cursor input format', () => {
    it('handles tool_output as JSON string', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'ffffffffffffffffffffffffffffffffffffffff', stats: {} }),
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

    it('silent when tool_output string indicates failure', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'ffffffffffffffffffffffffffffffffffffffff', stats: {} }),
      );

      const result = runHook(CURSOR_HOOK, {
        hook_event_name: 'postToolUse',
        tool_name: 'Shell',
        tool_input: { command: 'git commit -m "fail"' },
        tool_output: '{"exit_code": 128}',
        cwd: tmpDir,
      });

      const ctx = parseCursorHookOutput(result.stdout);
      expect(ctx).toBeNull();
    });

    it('resolves cwd from workspace_roots', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'ffffffffffffffffffffffffffffffffffffffff', stats: {} }),
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

    it('handles unparseable tool_output string gracefully (fail open)', () => {
      fs.writeFileSync(
        path.join(gitNexusDir, 'meta.json'),
        JSON.stringify({ lastCommit: 'ffffffffffffffffffffffffffffffffffffffff', stats: {} }),
      );

      const result = runHook(CURSOR_HOOK, {
        hook_event_name: 'postToolUse',
        tool_name: 'Shell',
        tool_input: { command: 'git commit -m "test"' },
        tool_output: 'not valid json at all',
        cwd: tmpDir,
      });

      const ctx = parseCursorHookOutput(result.stdout);
      expect(ctx).not.toBeNull();
      expect(ctx).toContain('stale');
    });
  });
});
