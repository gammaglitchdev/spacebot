//! Cortex chat: persistent admin conversation with the cortex.
//!
//! One session per agent. The admin talks to the cortex interactively,
//! with the full toolset (memory, shell, file, exec, browser, web search).
//! When opened on a channel page, the channel's recent history is injected
//! into the system prompt as context.

use crate::conversation::history::ProcessRunLogger;
use crate::llm::SpacebotModel;
use crate::{AgentDeps, ProcessType};

use rig::agent::AgentBuilder;
use rig::completion::{AssistantContent, CompletionModel, Prompt};
use rig::tool::server::ToolServerHandle;
use serde::Serialize;
use sqlx::SqlitePool;

use std::sync::Arc;
use tokio::sync::Mutex;

/// A persisted cortex chat message.
#[derive(Debug, Clone, Serialize)]
pub struct CortexChatMessage {
    pub id: String,
    pub thread_id: String,
    pub role: String,
    pub content: String,
    pub channel_context: Option<String>,
    pub created_at: String,
}

/// Events emitted during a cortex chat response (sent via SSE to the client).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CortexChatEvent {
    /// The cortex is processing (before LLM response).
    Thinking,
    /// A tool call started.
    ToolStarted { tool: String },
    /// A tool call completed.
    ToolCompleted { tool: String, result_preview: String },
    /// The full response is ready.
    Done { full_text: String },
    /// An error occurred.
    Error { message: String },
}

/// SQLite CRUD for cortex chat messages.
#[derive(Debug, Clone)]
pub struct CortexChatStore {
    pool: SqlitePool,
}

#[derive(sqlx::FromRow)]
struct ChatMessageRow {
    id: String,
    thread_id: String,
    role: String,
    content: String,
    channel_context: Option<String>,
    created_at: chrono::NaiveDateTime,
}

impl ChatMessageRow {
    fn into_message(self) -> CortexChatMessage {
        CortexChatMessage {
            id: self.id,
            thread_id: self.thread_id,
            role: self.role,
            content: self.content,
            channel_context: self.channel_context,
            created_at: self.created_at.and_utc().to_rfc3339(),
        }
    }
}

impl CortexChatStore {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Load chat history for a thread, newest first, then reverse to chronological order.
    pub async fn load_history(
        &self,
        thread_id: &str,
        limit: i64,
    ) -> Result<Vec<CortexChatMessage>, sqlx::Error> {
        let rows: Vec<ChatMessageRow> = sqlx::query_as(
            "SELECT id, thread_id, role, content, channel_context, created_at \
             FROM cortex_chat_messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT ?",
        )
        .bind(thread_id)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        let mut messages: Vec<CortexChatMessage> =
            rows.into_iter().map(|row| row.into_message()).collect();
        messages.reverse();
        Ok(messages)
    }

    /// Save a message to a thread. Returns the generated ID.
    pub async fn save_message(
        &self,
        thread_id: &str,
        role: &str,
        content: &str,
        channel_context: Option<&str>,
    ) -> Result<String, sqlx::Error> {
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO cortex_chat_messages (id, thread_id, role, content, channel_context) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(thread_id)
        .bind(role)
        .bind(content)
        .bind(channel_context)
        .execute(&self.pool)
        .await?;
        Ok(id)
    }

    /// Get the most recent thread_id, or None if no threads exist.
    pub async fn latest_thread_id(&self) -> Result<Option<String>, sqlx::Error> {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT thread_id FROM cortex_chat_messages ORDER BY created_at DESC LIMIT 1",
        )
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|r| r.0))
    }
}

/// The cortex chat session for a single agent.
///
/// Holds the deps, tool server, store, and a mutex to prevent concurrent sends.
pub struct CortexChatSession {
    pub deps: AgentDeps,
    pub tool_server: ToolServerHandle,
    pub store: CortexChatStore,
    /// Prevent concurrent sends — only one request at a time per agent.
    send_lock: Mutex<()>,
}

impl CortexChatSession {
    pub fn new(deps: AgentDeps, tool_server: ToolServerHandle, store: CortexChatStore) -> Self {
        Self {
            deps,
            tool_server,
            store,
            send_lock: Mutex::new(()),
        }
    }

    /// Send a message to the cortex chat and get the response.
    ///
    /// This is the non-streaming version. The caller wraps this in SSE by
    /// sending `thinking` -> running the call -> sending `done` / `error`.
    ///
    /// The channel_context_id is used to fetch recent channel history for
    /// injection into the system prompt.
    pub async fn send_message(
        &self,
        thread_id: &str,
        user_text: &str,
        channel_context_id: Option<&str>,
    ) -> Result<String, anyhow::Error> {
        let _guard = self.send_lock.lock().await;

        // Save the user message
        self.store
            .save_message(thread_id, "user", user_text, channel_context_id)
            .await?;

        // Build the system prompt
        let system_prompt = self.build_system_prompt(channel_context_id).await;

        // Load chat history and convert to Rig messages
        let chat_messages = self.store.load_history(thread_id, 100).await?;
        let mut history: Vec<rig::message::Message> = Vec::new();
        // Exclude the last message (the one we just saved) since we'll pass it as the prompt
        for message in &chat_messages[..chat_messages.len().saturating_sub(1)] {
            match message.role.as_str() {
                "user" => {
                    history.push(rig::message::Message::from(message.content.as_str()));
                }
                "assistant" => {
                    let content = AssistantContent::from(message.content.clone());
                    history.push(rig::message::Message::from(content));
                }
                _ => {}
            }
        }

        // Resolve model and build agent
        let routing = self.deps.runtime_config.routing.load();
        let model_name = routing.resolve(ProcessType::Branch, None).to_string();
        let model = SpacebotModel::make(&self.deps.llm_manager, &model_name)
            .with_routing((**routing).clone());

        let agent = AgentBuilder::new(model)
            .preamble(&system_prompt)
            .default_max_turns(50)
            .tool_server_handle(self.tool_server.clone())
            .build();

        // Run the agent
        let result = agent
            .prompt(user_text)
            .with_history(&mut history)
            .await;

        match result {
            Ok(response) => {
                // Save the assistant response
                self.store
                    .save_message(thread_id, "assistant", &response, channel_context_id)
                    .await?;
                Ok(response)
            }
            Err(error) => {
                let error_text = format!("Cortex chat error: {error}");
                // Save error as assistant message so history stays consistent
                self.store
                    .save_message(thread_id, "assistant", &error_text, channel_context_id)
                    .await?;
                Err(anyhow::anyhow!(error_text))
            }
        }
    }

    async fn build_system_prompt(&self, channel_context_id: Option<&str>) -> String {
        let runtime_config = &self.deps.runtime_config;
        let prompt_engine = runtime_config.prompts.load();

        let identity_context = runtime_config.identity.load().render();
        let memory_bulletin = runtime_config.memory_bulletin.load();

        let browser_enabled = runtime_config.browser_config.load().enabled;
        let web_search_enabled = runtime_config.brave_search_key.load().is_some();
        let opencode_enabled = runtime_config.opencode.load().enabled;
        let worker_capabilities = prompt_engine
            .render_worker_capabilities(browser_enabled, web_search_enabled, opencode_enabled)
            .expect("failed to render worker capabilities");

        // Load channel transcript if a channel context is active
        let channel_transcript = if let Some(channel_id) = channel_context_id {
            self.load_channel_transcript(channel_id).await
        } else {
            None
        };

        let empty_to_none = |s: String| if s.is_empty() { None } else { Some(s) };

        prompt_engine
            .render_cortex_chat_prompt(
                empty_to_none(identity_context),
                empty_to_none(memory_bulletin.to_string()),
                channel_transcript,
                worker_capabilities,
            )
            .expect("failed to render cortex chat prompt")
    }

    /// Load the last 50 messages from a channel as a formatted transcript.
    async fn load_channel_transcript(&self, channel_id: &str) -> Option<String> {
        let logger = ProcessRunLogger::new(self.deps.sqlite_pool.clone());

        match logger.load_channel_timeline(channel_id, 50).await {
            Ok(items) if !items.is_empty() => {
                let mut transcript = String::new();
                for item in &items {
                    match item {
                        crate::conversation::history::TimelineItem::Message {
                            role,
                            content,
                            sender_name,
                            ..
                        } => {
                            let name = sender_name.as_deref().unwrap_or(role);
                            transcript.push_str(&format!("**{name}**: {content}\n\n"));
                        }
                        crate::conversation::history::TimelineItem::BranchRun {
                            description,
                            conclusion,
                            ..
                        } => {
                            if let Some(conclusion) = conclusion {
                                transcript.push_str(&format!(
                                    "*[Branch: {description}]*: {conclusion}\n\n"
                                ));
                            }
                        }
                        crate::conversation::history::TimelineItem::WorkerRun {
                            task,
                            result,
                            ..
                        } => {
                            if let Some(result) = result {
                                transcript
                                    .push_str(&format!("*[Worker: {task}]*: {result}\n\n"));
                            }
                        }
                    }
                }
                Some(transcript)
            }
            Ok(_) => None,
            Err(error) => {
                tracing::warn!(%error, channel_id, "failed to load channel transcript for cortex chat");
                None
            }
        }
    }
}
