import { useEffect, useRef, useState } from "react";
import { useCortexChat } from "@/hooks/useCortexChat";
import { Markdown } from "@/components/Markdown";

interface CortexChatPanelProps {
	agentId: string;
	channelId?: string;
	onClose?: () => void;
}

export function CortexChatPanel({ agentId, channelId, onClose }: CortexChatPanelProps) {
	const { messages, isStreaming, error, sendMessage, newThread } = useCortexChat(agentId, channelId);
	const [input, setInput] = useState("");
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	// Auto-scroll on new messages
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages.length, isStreaming]);

	// Focus input on mount
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const handleSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		const trimmed = input.trim();
		if (!trimmed || isStreaming) return;
		setInput("");
		sendMessage(trimmed);
	};

	return (
		<div className="flex h-full w-full flex-col bg-app-darkBox/30">
			{/* Header */}
			<div className="flex h-12 items-center justify-between border-b border-app-line/50 px-4">
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium text-ink">Cortex</span>
					{channelId && (
						<span className="rounded bg-violet-500/10 px-1.5 py-0.5 text-tiny text-violet-400">
							{channelId.length > 24 ? `${channelId.slice(0, 24)}...` : channelId}
						</span>
					)}
				</div>
				<div className="flex items-center gap-1">
					<button
						onClick={newThread}
						disabled={isStreaming}
						className="rounded p-1 text-tiny text-ink-faint transition-colors hover:bg-app-darkBox hover:text-ink-dull disabled:opacity-30"
						title="New chat"
					>
						<svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
							<path d="M8 3v10M3 8h10" />
						</svg>
					</button>
					{onClose && (
						<button
							onClick={onClose}
							className="rounded p-1 text-ink-faint transition-colors hover:bg-app-darkBox hover:text-ink-dull"
							title="Close"
						>
							<svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
								<path d="M4 4l8 8M12 4l-8 8" />
							</svg>
						</button>
					)}
				</div>
			</div>

			{/* Messages */}
			<div className="flex-1 overflow-y-auto">
				<div className="flex flex-col gap-3 p-4">
					{messages.length === 0 && !isStreaming && (
						<p className="py-8 text-center text-sm text-ink-faint">
							Ask the cortex anything
						</p>
					)}
					{messages.map((message) => (
						<div
							key={message.id}
							className={`rounded-md px-3 py-2 ${
								message.role === "user"
									? "ml-8 bg-accent/10"
									: "mr-2 bg-app-darkBox/50"
							}`}
						>
							<span className={`text-tiny font-medium ${
								message.role === "user" ? "text-accent-faint" : "text-violet-400"
							}`}>
								{message.role === "user" ? "admin" : "cortex"}
							</span>
							<div className="mt-0.5 text-sm text-ink-dull">
								{message.role === "assistant" ? (
									<Markdown>{message.content}</Markdown>
								) : (
									<p>{message.content}</p>
								)}
							</div>
						</div>
					))}
					{isStreaming && (
						<div className="mr-2 rounded-md bg-app-darkBox/50 px-3 py-2">
							<span className="text-tiny font-medium text-violet-400">cortex</span>
							<div className="mt-1 flex items-center gap-1">
								<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
								<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400 [animation-delay:0.2s]" />
								<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400 [animation-delay:0.4s]" />
								<span className="ml-1 text-tiny text-ink-faint">thinking...</span>
							</div>
						</div>
					)}
					{error && (
						<div className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
							{error}
						</div>
					)}
					<div ref={messagesEndRef} />
				</div>
			</div>

			{/* Input */}
			<form onSubmit={handleSubmit} className="border-t border-app-line/50 p-3">
				<div className="flex gap-2">
					<input
						ref={inputRef}
						type="text"
						value={input}
						onChange={(event) => setInput(event.target.value)}
						placeholder={isStreaming ? "Waiting for response..." : "Message the cortex..."}
						disabled={isStreaming}
						className="flex-1 rounded-md border border-app-line bg-app-darkBox px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:border-violet-500/50 focus:outline-none disabled:opacity-50"
					/>
					<button
						type="submit"
						disabled={isStreaming || !input.trim()}
						className="rounded-md bg-violet-500/20 px-3 py-1.5 text-sm font-medium text-violet-400 transition-colors hover:bg-violet-500/30 disabled:opacity-30"
					>
						Send
					</button>
				</div>
			</form>
		</div>
	);
}
