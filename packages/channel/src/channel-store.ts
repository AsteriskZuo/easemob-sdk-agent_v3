import type { Database } from "@easemob/agent-database";
import { migrate } from "@easemob/agent-database";
import { SEGMENT_SEPARATOR } from "@easemob/agent-contracts";
import { channelMigrations } from "./channel-pool.js";

/** 业务通道 channel_id ↔ agent-cli 会话 id 映射。只管业务通道（exit__ 前缀的键调用即抛错） */
export interface ChannelStore {
  bindAgentSession(channelId: string, agentSessionId: string): void;
  getAgentSession(channelId: string): string | undefined;
  /** 清空：解除映射；下次触发即重绑新会话（通道标识不变，历史按时间追溯） */
  clear(channelId: string): void;
}

const EXIT_CHANNEL_PREFIX = `exit${SEGMENT_SEPARATOR}`;

function assertBusinessChannel(channelId: string): void {
  if (channelId.startsWith(EXIT_CHANNEL_PREFIX)) {
    throw new Error(`ChannelStore: 出口通道无 agent 会话: "${channelId}"`);
  }
}

interface SessionRow {
  agent_session_id: string;
}

export function createChannelStore(db: Database): ChannelStore {
  migrate(db, "channel", channelMigrations);

  return {
    bindAgentSession(channelId: string, agentSessionId: string): void {
      assertBusinessChannel(channelId);
      db.run(
        "INSERT OR REPLACE INTO channel_sessions (channel_id, agent_session_id, updated_at) VALUES (?, ?, ?)",
        [channelId, agentSessionId, new Date().toISOString()],
      );
    },

    getAgentSession(channelId: string): string | undefined {
      assertBusinessChannel(channelId);
      const row = db.get<SessionRow>(
        "SELECT agent_session_id FROM channel_sessions WHERE channel_id = ?",
        [channelId],
      );
      return row?.agent_session_id;
    },

    clear(channelId: string): void {
      assertBusinessChannel(channelId);
      db.run("DELETE FROM channel_sessions WHERE channel_id = ?", [channelId]);
    },
  };
}
