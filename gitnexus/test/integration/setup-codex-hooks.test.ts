import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { setupCommand } from '../../src/cli/setup.js';

describe('setupCommand Codex hooks integration', () => {
  let tempHome: string;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalPath = process.env.PATH;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-codex-hooks-'));
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    // Empty PATH forces the fallback branches:
    //   - setupCodex() can't find `codex` → writes config.toml directly
    //   - resolveGitnexusBin() can't find `gitnexus` → MCP entry uses npx
    process.env.PATH = '';

    await fs.mkdir(path.join(tempHome, '.codex'), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    process.env.PATH = originalPath;
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it('registers a PostToolUse Bash hook in ~/.codex/hooks.json', async () => {
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.codex', 'hooks.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      hooks?: {
        PostToolUse?: Array<{
          matcher?: string;
          hooks?: Array<{ type?: string; command?: string; timeout?: number }>;
        }>;
      };
    };

    expect(parsed.hooks?.PostToolUse).toBeDefined();
    expect(parsed.hooks!.PostToolUse).toHaveLength(1);
    const group = parsed.hooks!.PostToolUse![0];
    expect(group.matcher).toBe('Bash');
    expect(group.hooks).toHaveLength(1);
    expect(group.hooks![0].type).toBe('command');
    expect(group.hooks![0].command).toContain('gitnexus-hook.cjs');
    expect(group.hooks![0].timeout).toBe(10);
  });

  it('enables [features] codex_hooks = true in ~/.codex/config.toml', async () => {
    await setupCommand();

    const config = await fs.readFile(path.join(tempHome, '.codex', 'config.toml'), 'utf-8');
    expect(config).toMatch(/^\[features\][ \t]*$/m);
    expect(config).toMatch(/^codex_hooks\s*=\s*true\b/m);
  });

  it('copies the hook script with an absolute CLI path baked in (npm link safe)', async () => {
    await setupCommand();

    const scriptPath = path.join(tempHome, '.codex', 'hooks', 'gitnexus', 'gitnexus-hook.cjs');
    const script = await fs.readFile(scriptPath, 'utf-8');
    // Source uses a relative `path.resolve(__dirname, ...)`; installer
    // rewrites it to an absolute string so the script keeps working even
    // when run from outside the gitnexus package (e.g. via `npm link`).
    //
    // Under Vitest the rewrite resolves against `src/cli/` (no `dist/` in
    // the dev tree); in production it resolves against `dist/cli/`. Either
    // shape satisfies the contract that matters: the relative source line
    // is gone and `cliPath` now holds an absolute string ending in
    // `cli/index.js` with forward slashes.
    expect(script).not.toContain("path.resolve(__dirname, '..', '..', 'dist'");
    expect(script).toMatch(/let cliPath = "[^"]*\/cli\/index\.js";/);
  });

  it('is idempotent: a second setupCommand() does not duplicate the PostToolUse entry', async () => {
    await setupCommand();
    await setupCommand();

    const raw = await fs.readFile(path.join(tempHome, '.codex', 'hooks.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      hooks?: { PostToolUse?: unknown[] };
    };

    expect(parsed.hooks?.PostToolUse).toHaveLength(1);

    const config = await fs.readFile(path.join(tempHome, '.codex', 'config.toml'), 'utf-8');
    const featureLines = config.match(/^codex_hooks\s*=/gm) ?? [];
    expect(featureLines).toHaveLength(1);
  });

  it('preserves existing user PostToolUse entries and appends GitNexus alongside them', async () => {
    const existing = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo user-hook' }],
          },
        ],
      },
    };
    await fs.writeFile(
      path.join(tempHome, '.codex', 'hooks.json'),
      JSON.stringify(existing, null, 2),
      'utf-8',
    );

    await setupCommand();

    const parsed = JSON.parse(
      await fs.readFile(path.join(tempHome, '.codex', 'hooks.json'), 'utf-8'),
    ) as {
      hooks: {
        PostToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }>;
      };
    };

    expect(parsed.hooks.PostToolUse).toHaveLength(2);
    expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe('echo user-hook');
    expect(parsed.hooks.PostToolUse[1].hooks[0].command).toContain('gitnexus-hook.cjs');
  });

  it('respects an explicit codex_hooks = false and does not overwrite it', async () => {
    await fs.writeFile(
      path.join(tempHome, '.codex', 'config.toml'),
      '[features]\ncodex_hooks = false\n',
      'utf-8',
    );

    await setupCommand();

    const config = await fs.readFile(path.join(tempHome, '.codex', 'config.toml'), 'utf-8');
    expect(config).toMatch(/^codex_hooks\s*=\s*false\b/m);
    expect(config).not.toMatch(/^codex_hooks\s*=\s*true\b/m);
  });
});
