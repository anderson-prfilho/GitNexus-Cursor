<!-- version: 1.7.0 -->
<!-- Last updated: 2026-04-23 -->

Last reviewed: 2026-04-23

**Project:** GitNexus · **Environment:** dev · **Maintainer:** repository maintainers (see GitHub)

## Scope

| Boundary | Rule |
|----------|------|
| **Reads** | `gitnexus/`, `gitnexus-web/`, `eval/`, plugin packages, `.github/`, `.gitnexus/`, docs. |
| **Writes** | Only paths required for the change; keep diffs minimal. Update lockfiles when deps change. |
| **Executes** | `npm`, `npx`, `node` under `gitnexus/` and `gitnexus-web/`; `uv run` for Python under `eval/`; documented CI/dev workflows. |
| **Off-limits** | Real `.env` / secrets, production credentials, unrelated repos, destructive git ops without confirmation. |

## Model Configuration

- **Primary:** Use a named model (e.g. Claude Sonnet 4.x). Avoid `Auto` or unversioned `latest` when reproducibility matters.
- **Notes:** The GitNexus CLI indexer does not call an LLM.

## Execution Sequence (complex tasks)

For multi-step work, state up front:
1. Which rules in this file and **[GUARDRAILS.md](GUARDRAILS.md)** apply (and any relevant Signs).
2. Current **Scope** boundaries.
3. Which **validation commands** you will run (`cd gitnexus && npm test`, `npx tsc --noEmit`).

On long threads, *"Remember: apply all AGENTS.md rules"* re-weights these instructions against context dilution.

## Claude Code hooks

**PreToolUse** hooks can block tools (e.g. `git_commit`) until checks pass. Adapt to this repo: `cd gitnexus && npm test` before commit.

## Context budget

Commands and gotchas live under **Repo reference** below and in **[CONTRIBUTING.md](CONTRIBUTING.md)**. If always-on rules grow, split into **`.cursor/rules/*.mdc`** (globs). **Cursor:** project-wide rules in `.cursor/index.mdc`. **Claude Code:** load `STANDARDS.md` only when needed.

## Reference docs

- **[ARCHITECTURE.md](ARCHITECTURE.md)**, **[CONTRIBUTING.md](CONTRIBUTING.md)**, **[GUARDRAILS.md](GUARDRAILS.md)**
- **Call-resolution DAG (legacy path):** See ARCHITECTURE.md § Call-Resolution DAG. Typed 6-stage DAG inside the `parse` phase; language-specific behavior behind `inferImplicitReceiver` / `selectDispatch` hooks on `LanguageProvider`. Shared code in `gitnexus/src/core/ingestion/` must not name languages. Types: `gitnexus/src/core/ingestion/call-types.ts`.
- **Scope-resolution pipeline (RFC #909 Ring 3):** See ARCHITECTURE.md § Scope-Resolution Pipeline. Replaces the legacy DAG for languages in `MIGRATED_LANGUAGES` (see `registry-primary-flag.ts`). A language plugs in by implementing `ScopeResolver` (`scope-resolution/contract/scope-resolver.ts`) and registering it in `SCOPE_RESOLVERS`. CI parity gate runs BOTH paths per migrated language on every PR.
- **Cursor:** `.cursor/index.mdc` (always-on); `.cursor/rules/*.mdc` (glob-scoped). Legacy `.cursorrules` deprecated.
- **GitNexus:** skills in `.claude/skills/gitnexus/`; MCP rules in `gitnexus:start` block below.

## Changelog

| Date | Version | Change |
|------|---------|--------|
| 2026-04-23 | 1.7.0 | TypeScript added to `MIGRATED_LANGUAGES` (registry-primary call resolution by default). |
| 2026-04-20 | 1.6.0 | Added scope-resolution pipeline pointer (RFC #909 Ring 3); Python migrated to registry-primary. |
| 2026-04-19 | 1.5.0 | Cross-repo impact (#794): `impact`/`query`/`context` accept `repo: "@<group>"` + `service`. Removed `group_query`/`group_contracts`/`group_status` MCP tools; added `gitnexus://group/{name}/contracts` and `gitnexus://group/{name}/status` resources. |
| 2026-04-16 | 1.4.0 | Fixed: web UI description, pre-commit behavior, MCP tools (7->16), added gitnexus-shared, removed stale vite-plugin-wasm gotcha. |
| 2026-04-13 | 1.3.0 | Updated GitNexus index stats after DAG refactor. |
| 2026-03-24 | 1.2.0 | Fixed gitnexus:start block duplication. |
| 2026-03-23 | 1.1.0 | Updated agent instructions, references, Cursor layout. |
| 2026-03-22 | 1.0.0 | Initial structured header and changelog. |

---

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **GitNexus-Cursor** (19305 symbols, 26941 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/GitNexus-Cursor/context` | Codebase overview, check index freshness |
| `gitnexus://repo/GitNexus-Cursor/clusters` | All functional areas |
| `gitnexus://repo/GitNexus-Cursor/processes` | All execution flows |
| `gitnexus://repo/GitNexus-Cursor/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> **Claude Code:** PostToolUse hook detects a stale index after `git commit` and `git merge` and prompts the agent to run `analyze`. The hook does not invoke `analyze` itself. **Cursor:** use the GitNexus Cursor hook (`gitnexus/hooks/cursor/gitnexus-hook.cjs`) for similar automation after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.cursor/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.cursor/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.cursor/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.cursor/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.cursor/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.cursor/skills/gitnexus-cli/SKILL.md` |
| Work in the Ingestion area (311 symbols) | `.cursor/skills/ingestion/SKILL.md` |
| Work in the Type-extractors area (112 symbols) | `.cursor/skills/type-extractors/SKILL.md` |
| Work in the Cli area (93 symbols) | `.cursor/skills/cli/SKILL.md` |
| Work in the Group area (88 symbols) | `.cursor/skills/group/SKILL.md` |
| Work in the Configs area (78 symbols) | `.cursor/skills/configs/SKILL.md` |
| Work in the Server area (69 symbols) | `.cursor/skills/server/SKILL.md` |
| Work in the Wiki area (67 symbols) | `.cursor/skills/wiki/SKILL.md` |
| Work in the Components area (63 symbols) | `.cursor/skills/components/SKILL.md` |
| Work in the Local area (61 symbols) | `.cursor/skills/local/SKILL.md` |
| Work in the Scope-resolution area (55 symbols) | `.cursor/skills/scope-resolution/SKILL.md` |
| Work in the Embeddings area (55 symbols) | `.cursor/skills/embeddings/SKILL.md` |
| Work in the Extractors area (52 symbols) | `.cursor/skills/extractors/SKILL.md` |
| Work in the Unit area (50 symbols) | `.cursor/skills/unit/SKILL.md` |
| Work in the Lbug area (50 symbols) | `.cursor/skills/lbug/SKILL.md` |
| Work in the Workers area (40 symbols) | `.cursor/skills/workers/SKILL.md` |
| Work in the Hooks area (39 symbols) | `.cursor/skills/hooks/SKILL.md` |
| Work in the Csharp area (38 symbols) | `.cursor/skills/csharp/SKILL.md` |
| Work in the Services area (36 symbols) | `.cursor/skills/services/SKILL.md` |
| Work in the Cobol area (34 symbols) | `.cursor/skills/cobol/SKILL.md` |
| Work in the Storage area (32 symbols) | `.cursor/skills/storage/SKILL.md` |

<!-- gitnexus:end -->

## Repo reference

### Packages

| Package | Path | Purpose |
|---------|------|---------|
| **CLI/Core** | `gitnexus/` | TypeScript CLI, indexing pipeline, MCP server. Published to npm. |
| **Web UI** | `gitnexus-web/` | React/Vite thin client. All queries via `gitnexus serve` HTTP API. |
| **Shared** | `gitnexus-shared/` | Shared TypeScript types and constants. |
| Claude Plugin | `gitnexus-claude-plugin/` | Static config for Claude marketplace. |
| Cursor Integration | `gitnexus-cursor-integration/` | Static config for Cursor editor. |
| Eval | `eval/` | Python evaluation harness (Docker + LLM API keys). |

### Running services

```bash
cd gitnexus && npm run dev                 # CLI: tsx watch mode
cd gitnexus-web && npm run dev             # Web UI: Vite on port 5173
npx gitnexus serve                         # HTTP API on port 4747 (from any indexed repo)
```

### Testing

**CLI / Core (`gitnexus/`)**
- `npm test` — full vitest suite (~2000 tests)
- `npm run test:unit` — unit tests only
- `npm run test:integration` — integration (~1850 tests). LadybugDB file-locking tests may fail in containers (known env issue).
- `npx tsc --noEmit` — typecheck

**Web UI (`gitnexus-web/`)**
- `npm test` — vitest (~200 tests)
- `npm run test:e2e` — Playwright (7 spec files; requires `gitnexus serve` + `npm run dev`)
- `npx tsc -b --noEmit` — typecheck

**Pre-commit hook** (`.husky/pre-commit`): formatting (prettier via lint-staged) + typecheck for staged packages. Tests do **not** run in pre-commit — CI only.

### Gotchas

- `npm install` in `gitnexus/` triggers `prepare` (builds via `tsc`) and `postinstall` (patches tree-sitter-swift, builds tree-sitter-proto). Native bindings need `python3`, `make`, `g++`.
- `tree-sitter-kotlin` and `tree-sitter-swift` are optional — install warnings expected.
- ESLint configured via `eslint.config.mjs` (TS, React Hooks, unused-imports). No `npm run lint` script; use `npx eslint .`. Prettier runs via lint-staged. CI checks both in `ci-quality.yml`.
