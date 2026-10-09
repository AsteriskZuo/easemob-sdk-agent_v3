import type { EventEnvelope } from "@asteriskzuo/agent-contracts";
import type { Task, TaskFilter, TaskQueue } from "@asteriskzuo/agent-queue";
import type {
  BusinessMatch,
  BusinessPatch,
  BusinessProfile,
  BusinessRegistry,
  CreateBusinessInput,
  ExitBinding,
} from "@asteriskzuo/agent-registry";
import type { EnvConfig, EnvProvider } from "@asteriskzuo/agent-runtime";

/** 内存假队列：只实现入口适配器测试需要的 enqueue 幂等语义（event_id 唯一），
 *  其余 TaskQueue 方法为占位桩（测试不触达，触达即抛错暴露误用） */
export class FakeQueue {
  readonly tasks: Task[] = [];

  readonly queue: TaskQueue = {
    enqueue: (event: EventEnvelope): Task => {
      // event_id 幂等：已有同 id 任务直接返回（与真实队列语义一致）
      const existing = this.tasks.find(
        (t) => t.event.event_id === event.event_id,
      );
      if (existing !== undefined) return existing;
      const task: Task = {
        task_id: `task_${this.tasks.length + 1}`,
        event,
        status: "pending",
        enqueued_at: new Date().toISOString(),
      };
      this.tasks.push(task);
      return task;
    },
    take: () => {
      throw new Error("FakeQueue.take: 测试未实现");
    },
    complete: () => {
      throw new Error("FakeQueue.complete: 测试未实现");
    },
    deadLetter: () => {
      throw new Error("FakeQueue.deadLetter: 测试未实现");
    },
    query: (_filter: TaskFilter) => {
      throw new Error("FakeQueue.query: 测试未实现");
    },
    recover: () => 0,
    purge: () => 0,
  };
}

interface FakeBusinessState {
  profile: BusinessProfile;
  matches: BusinessMatch[];
}

/** 内存假注册表：实现入口适配器依赖的 list/get/addMatch/removeMatch/create/remove，
 *  其余方法为占位桩。BusinessProfile 读面不含匹配行（既有契约），适配器经 get() 取行 */
export class FakeRegistry {
  private readonly businesses = new Map<string, FakeBusinessState>();
  private seq = 0;

  readonly registry: BusinessRegistry = {
    match: (source, event_type) => {
      const rows: BusinessMatch[] = [];
      for (const state of this.businesses.values()) {
        for (const m of state.matches) {
          if (m.source === source && m.event_type === event_type) rows.push(m);
        }
      }
      return rows;
    },
    exitBindings: (_business_id): ExitBinding[] => [],
    get: (business_id) => [
      ...(this.businesses.get(business_id)?.matches ?? []),
    ],
    getProfile: (business_id) => this.businesses.get(business_id)?.profile,
    list: () => [...this.businesses.values()].map((state) => state.profile),
    update: (_business_id, _patch: BusinessPatch) => {
      throw new Error("FakeRegistry.update: 测试未实现");
    },
    create: (input: CreateBusinessInput): string => {
      this.seq += 1;
      const businessId = `b${this.seq}`;
      const profile: BusinessProfile = {
        business_id: businessId,
        business_name: input.business_name,
        creator_id: input.creator_id,
        on_failure: input.on_failure ?? false,
        prompt: input.prompt ?? "",
        model: input.model ?? "",
        agent_kind: input.agent_kind ?? "pi",
        tool_asset_ids: [],
        skill_asset_ids: [],
      };
      const firstRow: BusinessMatch = {
        business_id: businessId,
        business_name: input.business_name,
        creator_id: input.creator_id,
        source: input.source,
        event_type: input.event_type,
        on_failure: input.on_failure ?? false,
      };
      this.businesses.set(businessId, {
        profile,
        matches: [firstRow],
      });
      return businessId;
    },
    addMatch: (business_id, source, event_type, entry_config) => {
      const state = this.businesses.get(business_id);
      if (state === undefined) {
        throw new Error(`FakeRegistry.addMatch: 业务不存在: ${business_id}`);
      }
      const row: BusinessMatch = {
        business_id,
        business_name: state.profile.business_name,
        creator_id: state.profile.creator_id,
        source,
        event_type,
        on_failure: state.profile.on_failure,
      };
      if (entry_config !== undefined) row.entry_config = entry_config;
      state.matches.push(row);
    },
    removeMatch: (business_id, source, event_type) => {
      const state = this.businesses.get(business_id);
      if (state === undefined) return;
      state.matches = state.matches.filter(
        (m) => !(m.source === source && m.event_type === event_type),
      );
    },
    remove: (business_id) => {
      this.businesses.delete(business_id);
    },
  };

  /** 建业务（首个匹配行 source='manual' 占位，适配器测试只用 addMatch 加的行），返回 business_id */
  createBusiness(): string {
    return this.registry.create({
      business_name: "测试业务",
      creator_id: "tester",
      source: "manual",
      event_type: "test.placeholder",
    });
  }
}

/** 内存假两桶环境配置：getFor 只回业务级桶（通用层合并语义测试不涉及） */
export class FakeEnv {
  private readonly buckets = new Map<string, EnvConfig>();

  readonly env: EnvProvider = {
    getFor: (business_id) => {
      const config = this.buckets.get(business_id);
      return {
        vars: { ...(config?.vars ?? {}) },
        secrets: { ...(config?.secrets ?? {}) },
      };
    },
    set: (business_id, bucket, key, value) => {
      const scope = business_id ?? "";
      const config = this.buckets.get(scope) ?? { vars: {}, secrets: {} };
      config[bucket][key] = value;
      this.buckets.set(scope, config);
    },
    remove: (business_id, bucket, key) => {
      const config = this.buckets.get(business_id ?? "");
      if (config === undefined) return;
      delete config[bucket][key];
    },
    list: (business_id) => {
      const config = this.buckets.get(business_id ?? "");
      return {
        vars: { ...(config?.vars ?? {}) },
        secret_keys: Object.keys(config?.secrets ?? {}),
      };
    },
  };

  /** 测试便利：直接写一条 secret */
  setSecret(business_id: string, key: string, value: string): void {
    this.env.set(business_id, "secrets", key, value);
  }
}
