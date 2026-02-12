# MVP Roadmap

Tracking progress toward a working Spacebot that can hold a conversation, delegate work, manage memory, and connect to at least one messaging platform.

For each piece: reference IronClaw, OpenClaw, Nanobot, and Rig for inspiration, but make design decisions that align with Spacebot's architecture. Don't copy patterns that assume a monolithic session model.

---

## Current State

**What exists and compiles (zero errors, warnings only):**
- Project structure — all modules declared, module root pattern (`src/memory.rs` not `mod.rs`)
- Error hierarchy — thiserror domain enums (`ConfigError`, `DbError`, `LlmError`, `MemoryError`, `AgentError`, `SecretsError`) wrapped by top-level `Error` with `#[from]`
- Config loading — env-based with compaction/channel defaults, data dir setup
- Database connections — SQLite (sqlx) + LanceDB + redb, migration runner wired in `db.rs`
- LLM — `SpacebotModel` implements Rig's `CompletionModel` trait (completion, make, stream stub). Routes through `LlmManager` via direct HTTP to Anthropic and OpenAI. Handles tool definitions in requests and tool calls in responses.
- Memory — types (`Memory`, `Association`, `MemoryType`, `RelationType`), SQLite store (full CRUD + associations + content search), embedding generation (fastembed), hybrid search (FTS + graph traversal + RRF fusion), maintenance (decay/prune stubs)
- Agent structs — Channel (278 lines, event loop with `tokio::select!`, branch/worker spawning, status block), Branch (107 lines, history clone, recall, conclusion return), Worker (155 lines, state machine with `can_transition_to`), Compactor (141 lines, tiered thresholds), Cortex (117 lines, signal processing). Core LLM calls within agents are simulated — the surrounding infrastructure is real.
- StatusBlock — event-driven updates from `ProcessEvent`, renders to context string
- SpacebotHook — tool start/complete events, leak detection regexes (`LazyLock`), status updates
- Messaging — `Messaging` trait with RPITIT + `MessagingDyn` companion + blanket impl. `MessagingManager` with adapter registry. Discord/Telegram/Webhook adapters are empty stubs.
- Tools — 11 tool files. Real implementations: `memory_save`, `memory_recall`, `shell`, `file` (with path guards), `exec`, `set_status`. Stubs: `reply`, `branch_tool`, `spawn_worker`, `route`, `cancel`.
- `ToolServerHandle` wraps Rig's `ToolSet` with `register()`, but individual tools don't implement Rig's `Tool` trait yet — they're standalone async functions.
- Core types in `lib.rs` — `InboundMessage`, `OutboundResponse`, `StatusUpdate`, `ProcessEvent`, `AgentDeps`, `ProcessId`, `ProcessType`, `ChannelId`, `WorkerId`, `BranchId`
- `main.rs` — CLI (clap), tracing, config/DB/LLM init, event loop, graceful shutdown

**What's missing:**
- SQLite migrations (migrations/ directory is empty — tables created inline in `memory/store.rs`)
- LanceDB vector storage (lance.rs is a stub — no table management, no embedding insert/query)
- Tools not registered as Rig `Tool` trait impls (no `const NAME`, no `Args`/`Output` types, no `JsonSchema`)
- No system prompts (`prompts/` directory doesn't exist)
- No identity files (SOUL.md, IDENTITY.md, USER.md)
- No conversation history persistence
- Agent LLM calls are simulated (placeholder `tokio::time::sleep` instead of real `agent.prompt()`)
- Streaming not implemented (SpacebotModel.stream() returns error)
- Secrets and settings stores are empty stubs

---

## Phase 1: Migrations and LanceDB

Move table creation out of Rust code and into proper migrations. Get vector storage working.

- [ ] Write SQLite migrations: memories, associations, conversations, conversation_archives tables
- [ ] Remove inline `CREATE TABLE` from `memory/store.rs` (use sqlx migrations only)
- [ ] Implement `memory/lance.rs` — table creation, embedding insert, vector search (HNSW)
- [ ] Wire embedding generation into memory save flow (generate on create, store in LanceDB)
- [ ] Connect vector results into hybrid search (currently FTS + graph only, no vector)
- [ ] Test: save a memory, search by semantic similarity

**Reference:** IronClaw's pgvector HNSW config (`m=16, ef_construction=64`) for index parameters. The search module already has RRF — it just needs real vector results to fuse.

---

## Phase 2: Wire Tools to Rig

Individual tools need to implement Rig's `Tool` trait so they work with `AgentBuilder.tool()` and the agentic loop.

- [ ] Implement tools as Rig `Tool` trait impls (`const NAME`, `Args: Deserialize + JsonSchema`, `Output: Serialize`, `definition()`, `call()`)
- [ ] Create shared ToolServer for channel/branch tools (reply, branch, spawn_worker, memory_save, route, cancel)
- [ ] Create per-worker ToolServer factory for task tools (shell, file, exec, set_status)
- [ ] Replace current `ToolServerHandle` wrapper — use Rig's `ToolServer::run()` → `ToolServerHandle` directly, or wrap it properly (current Clone impl loses all tools)
- [ ] Update AgentDeps to hold a real `rig::tool::server::ToolServerHandle`

**Reference:** Rig's `Tool` trait: `const NAME`, `type Args`, `type Output`, `fn definition()`, `fn call()`. Doc comments on input structs serve as LLM instructions. `ToolServer::run()` consumes the server and returns a handle (channel-based, Clone is free).

---

## Phase 3: System Prompts and Identity

Create the prompt files and identity loading that give agents their behavior.

- [ ] Create `prompts/` directory
- [ ] Write `prompts/channel.md` — personality, delegation instructions, tool usage guide
- [ ] Write `prompts/branch.md` — thinking instructions, memory recall guidance
- [ ] Write `prompts/worker.md` — task execution instructions, status reporting
- [ ] Write `prompts/compactor.md` — summarization and memory extraction instructions
- [ ] Implement `identity/files.rs` — load SOUL.md, IDENTITY.md, USER.md from config dir
- [ ] Build context assembly in `conversation/context.rs` — combine prompt + identity + memories + status block

**Reference:** OpenClaw's skills-as-prompt-injections for channel prompt structure. Nanobot's context building (~236 lines) as a simplicity target. Identity files are raw text injected into system prompts, not parsed.

---

## Phase 4: The Channel (MVP Core)

The user-facing agent. Replace simulated logic with real Rig agent calls.

- [ ] Wire `AgentBuilder::new(model).preamble(&prompt).tool_server_handle(tools).default_max_turns(5).build()`
- [ ] Replace placeholder message handling with `agent.prompt(&message).with_history(&mut history).max_turns(5).await`
- [ ] Wire status block injection — prepend rendered status to each prompt call
- [ ] Implement conversation history persistence (`conversation/history.rs`) — save/load from SQLite
- [ ] Fire-and-forget DB writes for message persistence (`tokio::spawn`, don't block the response)
- [ ] Test: send a message to a channel, get a real LLM response back

**Reference:** Rig's `agent.prompt().with_history(&mut history).max_turns(5)` is the core call. The channel never blocks on branches, workers, or compaction.

---

## Phase 5: Branches and Workers

Replace simulated branch/worker execution with real agent calls.

- [ ] Branch: wire `agent.prompt(&task).with_history(&mut branch_history).max_turns(10).await`
- [ ] Branch result injection — insert conclusion into channel history as a distinct message
- [ ] Branch concurrency limit enforcement (already scaffolded, needs testing)
- [ ] Worker: wire `agent.prompt(&task).max_turns(50).await` with task-specific tools
- [ ] Interactive worker follow-ups — repeated `.prompt()` calls with accumulated history
- [ ] Worker status reporting via set_status tool → StatusBlock updates
- [ ] Handle stale branch results and worker timeout via Rig's `MaxTurnsError` / `PromptCancelled`

**Reference:** No existing codebase has context forking. Branch is `channel_history.clone()` run independently. Workers get fresh history + task description. Rig returns chat history in error types for recovery.

---

## Phase 6: Compactor

Wire the compaction workers to do real summarization.

- [ ] Implement compaction worker — summarize old turns + extract memories via LLM
- [ ] Emergency truncation — drop oldest turns without LLM, keep N recent
- [ ] Pre-compaction archiving — write raw transcript to conversation_archives table
- [ ] Non-blocking swap — replace old turns with summary while channel continues

**Reference:** IronClaw's tiered compaction (80/85/95 thresholds, already implemented). The novel part is the non-blocking swap.

---

## Phase 7: Webhook Messaging Adapter

Get a real end-to-end messaging path working.

- [ ] Implement WebhookAdapter (axum) — POST endpoint, InboundMessage production, response routing
- [ ] Implement MessagingManager.start() — spawn adapters, merge inbound streams via `select_all`
- [ ] Implement outbound routing — responses flow from channel → manager → correct adapter
- [ ] Optional sync mode (`"wait": true` blocks until agent responds)
- [ ] Wire the full path: HTTP POST → InboundMessage → Channel → response → OutboundResponse → HTTP response
- [ ] Test: curl a message in, get a response back

**Reference:** IronClaw's Channel trait and ChannelManager with `futures::stream::select_all()`. The Messaging trait and MessagingDyn companion are already implemented.

---

## Phase 8: End-to-End Integration

Wire everything together into a running system.

- [ ] main.rs orchestration — init config, DB, LLM, memory, tools, messaging, start event loop
- [ ] Event routing — ProcessEvent fan-in from all agents, dispatch to appropriate handlers
- [ ] Channel lifecycle — create on first message, persist across restarts, resume from DB
- [ ] Test the full loop: message in → channel → branch → worker → memory save → response out
- [ ] Graceful shutdown — broadcast signal, drain in-flight work, close DB connections

---

## Post-MVP

Not blocking the first working version, but next in line.

- **Streaming** — implement `SpacebotModel.stream()` with SSE parsing, wire through messaging adapters with block coalescing (see `docs/messaging.md`)
- **Cortex** — system-level observer, memory consolidation, decay management. No reference codebase for this.
- **Heartbeats** — scheduled tasks with fresh channels. Circuit breaker (3 failures → disable).
- **Telegram adapter** — real messaging platform integration.
- **Discord adapter** — thread-based conversations map naturally to channels.
- **Secrets store** — AES-256-GCM encrypted credentials in redb.
- **Settings store** — redb key-value with env > DB > default resolution.
- **Memory graph traversal during recall** — walk typed edges (Updates, Contradicts, CausedBy) during search.
- **Multi-channel identity coherence** — same soul across conversations, cortex consolidates across channels.
