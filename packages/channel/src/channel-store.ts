import type { Database } from "@asteriskzuo/agent-database";
import { migrate } from "@asteriskzuo/agent-database";
import { SEGMENT_SEPARATOR } from "@asteriskzuo/agent-contracts";
import { channelMigrations } from "./channel-pool.js";

/** 业务通道 channel_id ↔ agent-cli 会话 id 映射。只管业务通道（exit__ 前缀的键调用即抛错） */
export interface ChannelStore {
  /** 绑定/重绑：INSERT OR REPLACE 语义（重绑覆盖旧映射） */
  bindAgentSession(channelId: string, agentSessionId: string): void;
  /** 查映射；未命中返回 undefined */
  getAgentSession(channelId: string): string | undefined;
  /** 清空：解除映射；下次触发即重绑新会话（通道标识不变，历史按时间追溯）。DELETE 语义，键不存在幂等 */
  clear(channelId: string): void;
}

// 出口通道前缀（exit__）：出口通道不过 LLM、无 agent 会话，不进本映射
const EXIT_CHANNEL_PREFIX = `exit${SEGMENT_SEPARATOR}`;

/** 出口通道防护：exit__ 前缀的键调用即抛错（三个方法统一走这里） */
function assertBusinessChannel(channelId: string): void {
  if (channelId.startsWith(EXIT_CHANNEL_PREFIX)) {
    throw new Error(`ChannelStore: 出口通道无 agent 会话: "${channelId}"`);
  }
}

interface SessionRow {
  agent_session_id: string;
}

/** 创建映射存储。与 ChannelPool 共用 module 'channel' 的同一份迁移（channel_sessions 表） */
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
