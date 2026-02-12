# The Cortex

The cortex is the system's awareness of itself. Every other process in Spacebot is focused on a specific job — channels talk to users, branches think, workers execute, compactors manage context. None of them see the whole picture. The cortex does.

## Why It Exists

With channels spawning branches, branches spawning workers, compactors running in the background, and heartbeats firing on schedules — things get messy. Workers hang. Branches go stale. Memory accumulates duplicates. Conversations diverge across channels while the same person says contradictory things in two different threads.

Nobody is watching. Nobody is cleaning up. Nobody is connecting the dots across conversations.

That's the cortex. It's not a feature — it's the thing that keeps the system from rotting.

## What It Does

The cortex has three responsibilities, in priority order:

### 1. System Health

The cortex monitors every running process and keeps the system clean.

**Worker supervision:**
- Track all active workers across all channels
- Detect hanging workers (no status update within a configurable timeout)
- For hanging workers: attempt repair (send a nudge/follow-up), and if still stuck, kill it
- Detect workers in error loops (same error 3+ times) and terminate them
- Clean up completed workers that channels haven't acknowledged

**Branch supervision:**
- Detect stale branches (running longer than expected for their task type)
- Kill branches that have exceeded their turn limit without returning
- Track branch-to-result latency to identify systemic slowdowns

**Channel health:**
- Monitor compaction thresholds across channels
- Detect channels that are approaching context limits faster than compactors can keep up
- Flag channels that have stopped responding (crashed event loop, stuck on a prompt)

**Error aggregation:**
- Collect errors from all processes
- Detect patterns: is a specific tool failing across multiple workers? Is a provider returning errors? Is embedding generation timing out?
- Apply circuit breakers: after 3 consecutive failures of the same type, disable the failing component and log a system-level warning

### 2. Memory Coherence

The cortex is the only process that sees memory activity across all channels. It maintains the graph.

**Consolidation:**
- When multiple channels save similar memories, merge them (>0.95 embedding similarity)
- Create `Updates` associations when a newer memory supersedes an older one
- Create `Contradicts` associations when memories conflict
- Generate cross-channel associations: a fact from Channel A connects to a decision from Channel B

**Maintenance:**
- Run importance decay on a schedule (reduce scores for old, unaccessed memories)
- Prune memories below the importance floor (identity/permanent exempt)
- Recompute graph centrality scores after significant graph changes
- Detect orphaned memories (no associations, low importance, never recalled) and flag for cleanup

**Observations:**
- Generate observation-type memories from patterns: "James has been asking about database migrations across multiple conversations this week"
- These are lower-importance, system-generated memories that provide longitudinal awareness
- The cortex is the only process that creates observations — channels and branches save facts, preferences, and decisions

### 3. Progression

The cortex keeps the system moving forward. It's on its own loop — not a heartbeat (those are user-defined scheduled tasks), but an internal tick that runs continuously.

**The cortex loop:**
1. Receive signals from across the system (via the event bus)
2. Buffer signals into a rolling window
3. On each tick (configurable interval, default ~30s):
   - Check system health (workers, branches, channels)
   - Process buffered signals for patterns
   - Run maintenance if due (memory decay, pruning — not every tick)
   - Act on anything that needs intervention
4. Sleep until next tick or until a high-priority signal arrives (errors, timeouts)

The cortex can escalate its own tick rate when things are busy. During quiet periods, it backs off. During high error rates, it runs more frequently.

## What It Sees

The cortex operates on signals, not raw data. It never sees conversation text, tool call arguments, or full memory contents. It sees:

| Signal | Source | Contains |
|--------|--------|----------|
| `ChannelStarted` | Channel lifecycle | channel_id, conversation_id |
| `ChannelEnded` | Channel lifecycle | channel_id, reason |
| `WorkerSpawned` | Branch/Channel | worker_id, channel_id, task_summary |
| `WorkerStatusUpdate` | Worker (via set_status) | worker_id, status string |
| `WorkerCompleted` | Worker lifecycle | worker_id, result_summary, duration |
| `WorkerFailed` | Worker lifecycle | worker_id, error_summary |
| `BranchSpawned` | Channel | branch_id, channel_id, description |
| `BranchReturned` | Branch lifecycle | branch_id, duration |
| `MemorySaved` | Branch/Compactor | memory_id, memory_type, importance, content_preview |
| `CompactionRun` | Compactor | channel_id, turns_compacted, new_summary_length |
| `Error` | Any process | source_process, error_type, error_message |

Signals are lightweight. The cortex can process hundreds per tick without context pressure. Its own context window stays small because it works on summaries and metadata, not content.

## How It Differs From Other Processes

| Property | Channel | Branch | Worker | Cortex |
|----------|---------|--------|--------|--------|
| Sees conversations | Yes | Yes (forked) | No | No |
| Talks to users | Yes | No | No | No |
| Has personality | Yes | Inherited | No | No |
| Scope | One conversation | One thought | One task | Entire system |
| Lifecycle | Long-lived | Seconds | Minutes to hours | Always running |
| Context growth | High (needs compaction) | Moderate (disposable) | Moderate (disposable) | Low (signals only) |

The cortex is the only singleton in the system. There's one cortex, regardless of how many channels, branches, or workers are running. At extreme scale (100+ concurrent channels), multiple cortex instances could partition the signal space, but that's a scaling concern, not a design concern.

## Cortex vs Heartbeats

These are different things:

**Heartbeats** are user-defined scheduled tasks. "Check my inbox every 30 minutes." "Generate a daily summary at 9am." They run on cron-style schedules, get fresh channels with full branching and worker capabilities, and produce user-facing output.

**The cortex** is the system's internal loop. It's not user-configured. It's not producing output for anyone. It's maintaining system health, memory coherence, and cross-channel awareness. It runs continuously, not on a schedule.

The cortex *manages* heartbeats — it applies circuit breakers when heartbeats fail, monitors their health, and could in theory create new heartbeats if it detects a pattern that warrants scheduled attention. But the cortex itself is not a heartbeat.

## Cortex vs Compactor

Also different things:

**Compactors** are per-channel, programmatic monitors. They watch one channel's context size and trigger compaction workers. They're not LLM processes — they're threshold checkers.

**The cortex** is an LLM process that sees across all channels. It doesn't manage context size (that's the compactor's job). It manages memory coherence, system health, and cross-channel patterns.

The compactor says "this channel is 82% full, run a compaction worker." The cortex says "three channels have saved contradicting memories about the database choice, let me consolidate those."

## The Signal Bus

All processes emit events to a shared `mpsc` channel. The cortex subscribes to this channel and maps events to signals. Not every event becomes a signal — the cortex filters for what matters at the system level.

```
Channel A emits: ToolStarted { tool: "reply", ... }     → cortex ignores (too granular)
Channel A emits: WorkerComplete { result: "...", ... }   → cortex maps to WorkerCompleted signal
Worker 7 emits: StatusUpdate { status: "stuck on..." }   → cortex maps to WorkerStatusUpdate signal
Branch 3 emits: ToolCompleted { tool: "memory_save" }    → cortex maps to MemorySaved signal
```

The cortex doesn't poll. It reacts to signals as they arrive, buffers them, and processes them on its tick cycle.

## Tools

The cortex has two tools, distinct from what channels and workers get:

**memory_consolidate** — Merge, associate, deprecate, or prune memories in the graph. This is the cortex's primary mechanism for maintaining memory coherence. It can:
- Merge two memories into one (keeping the better content, combining associations)
- Create typed associations between memories
- Lower importance on deprecated memories
- Flag memories for review

**system_monitor** — Query the current state of the system. Active channels, running workers, pending branches, memory store stats (total memories, type distribution, importance histogram), error rates, recent compaction history. This gives the cortex situational awareness before it decides what to act on.

## Configuration

```toml
[cortex]
# Base tick interval in seconds. Cortex checks system health on this cycle.
tick_interval_secs = 30

# Worker is considered hanging if no status update for this long.
worker_timeout_secs = 300

# Branch is considered stale after this duration.
branch_timeout_secs = 60

# Maximum signals to keep in the rolling buffer.
signal_buffer_size = 200

# Memory maintenance runs every N ticks.
maintenance_interval_ticks = 20

# Consecutive failures before circuit breaker trips.
circuit_breaker_threshold = 3

# Model to use for cortex LLM calls (consolidation reasoning).
model = "anthropic/claude-sonnet-4-20250514"
```

The cortex should be cheap to run. It processes signals, not conversations. Most ticks involve no LLM calls — just health checks and bookkeeping. LLM calls happen only when the cortex needs to reason about memory consolidation or pattern detection.

## Failure Modes

**What if the cortex crashes?**
The system keeps running. Channels still talk to users, branches still think, workers still execute. Memory consolidation stops, dead workers don't get cleaned up, and cross-channel coherence degrades — but nothing breaks immediately. On restart, the cortex catches up from the signal bus.

**What if the cortex is overwhelmed?**
Signal buffer overflow drops oldest signals. The cortex operates on a best-effort basis for pattern detection. Health monitoring (killing stuck workers, circuit breakers) is prioritized over memory consolidation because health affects user experience directly.

**What if the cortex makes a bad consolidation?**
Memory operations are logged. Merges and deprecations are reversible (the original memories are archived, not deleted). The cortex is instructed to act conservatively — when in doubt, create an association instead of merging.
