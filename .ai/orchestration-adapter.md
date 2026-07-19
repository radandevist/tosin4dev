# Orchestration Adapter

| Field | Value |
|---|---|
| `default_branch` | `main` |
| `setup_cmd` | `bun install --frozen-lockfile` |
| `build_cmd` | `bun run build` |
| `test_cmd` | `bun run test` |
| `lint_cmd` | `bun run typecheck` |
| `acceptance_cmd` | `bun run test && bun run typecheck && bun run build` |
| `client_regen_cmd` | `none` |
| `worktree_root` | `/home/radan/.config/superpowers/worktrees/tosin4dev/<branch>` |
| `captain_root` | `/home/radan/Projects/Tosin4dev` |
| `clone_roots` | `none` |
| `host_parallelism` | Up to 4 lightweight agents; only 1 heavy build/test/Docker job at a time. |
| `executor` | Claude Sonnet/standard effort for implementation; Codex/high for independent review. |
| `model_ladder` | Claude implementer → Codex reviewer; reroute on quota without retry storms. |
| `provider_lanes` | Claude: implementation/fixes. Codex: spec and quality review. Local: git, setup, deterministic verification. |
| `hot_backlog` | Keep 3 ready packets; execute serially because tasks share scaffold files. |
| `packet_template` | `~/ai-orchestration-playbook/captain-packet-template.md` |
| `push_guard` | Soft gate: never push or commit directly to `main`; no merge without explicit owner approval. |
| `known_quirks` | Bun was absent at bootstrap; install once. TanStack Start APIs move quickly: use current official starter/patterns instead of blindly copying stale snippets. Do not run concurrent Docker/build gates. Use absolute paths. |
| `additive_merge_files` | `none` |
| `dump_dir` | `.dump/` |
| `issue_hierarchy` | No issue required for bootstrap v1; future PRs link a tracking issue when one exists. |
