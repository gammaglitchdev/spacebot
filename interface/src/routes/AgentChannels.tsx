import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { ChannelCard } from "@/components/ChannelCard";
import type { ChannelLiveState } from "@/hooks/useChannelLiveState";

interface AgentChannelsProps {
	agentId: string;
	liveStates: Record<string, ChannelLiveState>;
}

export function AgentChannels({ agentId, liveStates }: AgentChannelsProps) {
	const [searchQuery, setSearchQuery] = useState("");

	const { data: channelsData, isLoading } = useQuery({
		queryKey: ["channels"],
		queryFn: api.channels,
		refetchInterval: 10_000,
	});

	const channels = useMemo(() => {
		const agentChannels = (channelsData?.channels ?? []).filter((c) => c.agent_id === agentId);
		if (!searchQuery) return agentChannels;
		const query = searchQuery.toLowerCase();
		return agentChannels.filter(
			(c) =>
				c.id.toLowerCase().includes(query) ||
				(c.display_name && c.display_name.toLowerCase().includes(query)) ||
				(c.platform && c.platform.toLowerCase().includes(query)),
		);
	}, [channelsData, agentId, searchQuery]);

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-3 border-b border-app-line/50 bg-app-darkBox/20 px-6 py-3">
				<div className="relative flex-1">
					<input
						type="text"
						placeholder="Search channels..."
						value={searchQuery}
						onChange={(event) => setSearchQuery(event.target.value)}
						className="w-full rounded-md border border-app-line bg-app-darkBox px-3 py-1.5 pl-8 text-sm text-ink placeholder:text-ink-faint focus:border-accent/50 focus:outline-none"
					/>
					<svg
						className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
					>
						<circle cx="6.5" cy="6.5" r="5" />
						<path d="M10.5 10.5L14 14" />
					</svg>
				</div>
			</div>
			<div className="flex-1 overflow-y-auto p-6">
				{isLoading ? (
					<div className="flex items-center gap-2 text-ink-dull">
						<div className="h-2 w-2 animate-pulse rounded-full bg-accent" />
						Loading channels...
					</div>
				) : channels.length === 0 ? (
					<p className="text-sm text-ink-faint">
						{searchQuery ? "No channels matching your search." : "No active channels for this agent."}
					</p>
				) : (
					<div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
						{channels.map((channel) => (
							<ChannelCard
								key={channel.id}
								channel={channel}
								liveState={liveStates[channel.id]}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
