import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CortexChatMessage } from "@/api/client";

/** Parse SSE events from a ReadableStream response body. */
async function consumeSSE(
	response: Response,
	onEvent: (eventType: string, data: string) => void,
) {
	const reader = response.body?.getReader();
	if (!reader) return;

	const decoder = new TextDecoder();
	let buffer = "";

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";

		let currentEvent = "";
		let currentData = "";

		for (const line of lines) {
			if (line.startsWith("event: ")) {
				currentEvent = line.slice(7);
			} else if (line.startsWith("data: ")) {
				currentData = line.slice(6);
			} else if (line === "" && currentEvent) {
				onEvent(currentEvent, currentData);
				currentEvent = "";
				currentData = "";
			}
		}
	}
}

function generateThreadId(): string {
	return crypto.randomUUID();
}

export function useCortexChat(agentId: string, channelId?: string) {
	const [messages, setMessages] = useState<CortexChatMessage[]>([]);
	const [threadId, setThreadId] = useState<string | null>(null);
	const [isStreaming, setIsStreaming] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const loadedRef = useRef(false);

	// Load latest thread on mount
	useEffect(() => {
		if (loadedRef.current) return;
		loadedRef.current = true;

		api.cortexChatMessages(agentId).then((data) => {
			setThreadId(data.thread_id);
			setMessages(data.messages);
		}).catch((error) => {
			console.warn("Failed to load cortex chat history:", error);
			setThreadId(generateThreadId());
		});
	}, [agentId]);

	const sendMessage = useCallback(async (text: string) => {
		if (isStreaming || !threadId) return;

		setError(null);
		setIsStreaming(true);

		// Optimistically add user message
		const userMessage: CortexChatMessage = {
			id: `tmp-${Date.now()}`,
			thread_id: threadId,
			role: "user",
			content: text,
			channel_context: channelId ?? null,
			created_at: new Date().toISOString(),
		};
		setMessages((prev) => [...prev, userMessage]);

		try {
			const response = await api.cortexChatSend(agentId, threadId, text, channelId);
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}`);
			}

			await consumeSSE(response, (eventType, data) => {
				if (eventType === "done") {
					try {
						const parsed = JSON.parse(data);
						const assistantMessage: CortexChatMessage = {
							id: `resp-${Date.now()}`,
							thread_id: threadId,
							role: "assistant",
							content: parsed.full_text,
							channel_context: channelId ?? null,
							created_at: new Date().toISOString(),
						};
						setMessages((prev) => [...prev, assistantMessage]);
					} catch {
						setError("Failed to parse response");
					}
				} else if (eventType === "error") {
					try {
						const parsed = JSON.parse(data);
						setError(parsed.message);
					} catch {
						setError("Unknown error");
					}
				}
			});
		} catch (error) {
			setError(error instanceof Error ? error.message : "Request failed");
		} finally {
			setIsStreaming(false);
		}
	}, [agentId, channelId, threadId, isStreaming]);

	const newThread = useCallback(() => {
		setThreadId(generateThreadId());
		setMessages([]);
		setError(null);
	}, []);

	return { messages, threadId, isStreaming, error, sendMessage, newThread };
}
