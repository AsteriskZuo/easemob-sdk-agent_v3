import { migrate } from "@asteriskzuo/agent-database";
import type { Database } from "@asteriskzuo/agent-database";
import { newUlid } from "@asteriskzuo/agent-contracts";
import type { EventSource } from "@asteriskzuo/agent-contracts";

/** 匹配视图：注册表执行视图的一行。无 order/depends_on 字段——链内并行，
 *  顺序靠事件订阅表达 */
export interface BusinessMatch {
  business_id: string; // 创建时生成、不可修改，一切内部引用的锚
  business_name: string; // 展示名，可修改，不参与匹配
  creator_id: string; // 创建者，不可修改（权限归属判定用）
  source: EventSource; // 关注的来源（行级）
  event_type: string; // 关注的事件类型（行级）
  on_failure?: boolean; // 失败也扇出；默认 false
  entry_config?: Record<string, unknown>; // 入口配置（过滤配置、会话标识规则等）；平台不解析、原样存储透传，未配置 = undefined
}

/** 业务资料：业务级字段的完整读面（匹配视图 BusinessMatch 保持轻量不变） */
export interface BusinessProfile {
  business_id: string; // 创建时生成（'b'+ulid）、不可修改，一切内部引用的锚
  business_name: string; // 展示名，可修改，不参与匹配
  creator_id: string; // 创建者账号 id（权限归属判定用）
  on_failure: boolean; // 失败也扇出开关
  prompt: string; // 提示词总纲（可空串）
  model: string; // 大模型选择：provider/id 形式（如 qwen/qwen3.8-max）；可选集合由部署侧 models.json 决定
  agent_kind: string; // agent 内核（MVP 仅 pi）
  package_asset_id?: string; // 绑定的包资产；未绑定 = undefined
  entry_program?: string; // 流程程序入口名（包清单 programs 的键）
  tool_asset_ids: string[]; // 绑定的工具资产 id 列表，缺省 []
  skill_asset_ids: string[]; // 绑定的 skill 集合资产 id 列表，缺省 []
  timeout_minutes?: number; // run 超时覆盖；undefined = 用全局默认
  max_agent_calls?: number; // agent 调用次数配额覆盖；undefined = 用全局默认
}

/** 出口绑定：业务配置的一部分。config 只存非机密项 */
export interface ExitBinding {
  business_id: string; // 归属业务 = 出口循环的归属匹配键
  tool: string; // 出口工具 kind
  config: Record<string, string>; // 非机密配置（token 等机密项归环境配置模块，不存此处）
}

/** 业务级字段补丁（行级字段 source/event_type 不可 patch——改匹配 = 增删行） */
export interface BusinessPatch {
  business_name?: string; // 展示名
  on_failure?: boolean; // 失败也扇出开关
  exit_bindings?: ExitBinding[]; // 全量替换该业务的出口绑定
  prompt?: string; // 提示词总纲
  model?: string; // 大模型选择
  agent_kind?: string; // agent 内核
  package_asset_id?: string; // 包资产绑定
  entry_program?: string; // 流程程序入口名
  tool_asset_ids?: string[]; // 工具资产绑定（全量替换）
  skill_asset_ids?: string[]; // skill 集合资产绑定（全量替换）
  timeout_minutes?: number | null; // run 超时覆盖；显式 null = 清除覆盖（落库 NULL）
  max_agent_calls?: number | null; // agent 调用次数配额覆盖；显式 null = 清除覆盖（落库 NULL）
}

/** 创建业务输入（含首个匹配行）。资料字段全部可选——registry 层不做强必填校验
 * （机械存储；「包绑定/总纲必填」是控制台业务流程的校验职责） */
export interface CreateBusinessInput {
  business_name: string; // 展示名，可修改
  creator_id: string; // 创建者账号 id，不可修改（权限归属判定用）
  source: EventSource; // 首个匹配行
  event_type: string;
  on_failure?: boolean; // 缺省 false
  exit_bindings?: Array<{ tool: string; config: Record<string, string> }>; // 缺省无绑定
  prompt?: string; // 缺省 ''
  model?: string; // 缺省 ''（空串 = 未选择；registry 层机械存储，必选校验归控制台表单）
  agent_kind?: string; // 缺省 'pi'
  package_asset_id?: string; // 缺省未绑定
  entry_program?: string; // 缺省未指定
  tool_asset_ids?: string[]; // 缺省 []
  skill_asset_ids?: string[]; // 缺省 []
  timeout_minutes?: number; // 缺省无覆盖（用全局默认）
  max_agent_calls?: number; // 缺省无覆盖（用全局默认）
}

export interface BusinessRegistry {
  /** 入口循环订阅匹配（热路径，走内存视图）；无关注者返回空数组 */
  match(source: EventSource, event_type: string): BusinessMatch[];

  /** 出口循环归属匹配：产出方业务的全部出口绑定；无绑定返回空数组 */
  exitBindings(business_id: string): ExitBinding[];

  /** 取业务的全部匹配行（一对多）；业务不存在返回空数组 */
  get(business_id: string): BusinessMatch[];

  /** 取业务资料（业务级字段完整读面）；业务不存在返回 undefined */
  getProfile(business_id: string): BusinessProfile | undefined;

  /** 全部业务资料（控制台业务列表）；按 business_id 字典序 */
  list(): BusinessProfile[];

  /** 更新业务级字段（对该业务所有行生效）；业务不存在抛错 */
  update(business_id: string, patch: BusinessPatch): void;

  /** 创建业务（含首个匹配行），返回 business_id */
  create(input: CreateBusinessInput): string;

  /** 增删匹配行 = 增删入口/关注。addMatch 重复 (business_id,source,event_type) 幂等不报错。
   *  entry_config：该匹配行的入口配置（JSON object），平台不解析、原样存储透传 */
  addMatch(
    business_id: string,
    source: EventSource,
    event_type: string,
    entry_config?: Record<string, unknown>,
  ): void;
  removeMatch(
    business_id: string,
    source: EventSource,
    event_type: string,
  ): void;

  /** 删除业务（匹配行、出口绑定一并删）；不存在幂等不报错 */
  remove(business_id: string): void;
}

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE businesses (
     business_id TEXT PRIMARY KEY,
     business_name TEXT NOT NULL,
     creator_id TEXT NOT NULL,
     on_failure INTEGER NOT NULL DEFAULT 0,
     exit_bindings TEXT NOT NULL DEFAULT '[]'
   );
   CREATE TABLE business_matches (
     business_id TEXT NOT NULL,
     source TEXT NOT NULL,
     event_type TEXT NOT NULL,
     UNIQUE (business_id, source, event_type)
   );`,
  // v2：业务资料字段（提示词总纲/模型/内核/资产绑定/quota 覆盖）+ 匹配行入口配置；
  // 全部带缺省，与 v1 共存升级（老库 ALTER 后老数据不丢）
  `ALTER TABLE businesses ADD COLUMN prompt TEXT NOT NULL DEFAULT '';
   ALTER TABLE businesses ADD COLUMN model TEXT NOT NULL DEFAULT 'qwen3.8max';
   ALTER TABLE businesses ADD COLUMN agent_kind TEXT NOT NULL DEFAULT 'pi';
   ALTER TABLE businesses ADD COLUMN package_asset_id TEXT;
   ALTER TABLE businesses ADD COLUMN entry_program TEXT;
   ALTER TABLE businesses ADD COLUMN tool_asset_ids TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE businesses ADD COLUMN skill_asset_ids TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE businesses ADD COLUMN timeout_minutes INTEGER;
   ALTER TABLE businesses ADD COLUMN max_agent_calls INTEGER;
   ALTER TABLE business_matches ADD COLUMN entry_config TEXT;`,
  // v3：清理历史默认填入的模型名（旧值 'qwen3.8max' 缺 provider 前缀，本就不是合法模型名 → 归一为 '' = 未选择）。
  // v2 的 `DEFAULT 'qwen3.8max'` 是死代码（INSERT 恒显式给值），按迁移纪律保留不改
  `UPDATE businesses SET model = '' WHERE model = 'qwen3.8max';`,
];

interface BusinessRow {
  business_id: string;
  business_name: string;
  creator_id: string;
  on_failure: number;
  exit_bindings: string;
  prompt: string;
  model: string;
  agent_kind: string;
  package_asset_id: string | null;
  entry_program: string | null;
  tool_asset_ids: string;
  skill_asset_ids: string;
  timeout_minutes: number | null;
  max_agent_calls: number | null;
}

interface MatchRow {
  business_id: string;
  source: string;
  event_type: string;
  entry_config: string | null;
}

interface MatchState {
  source: EventSource;
  event_type: string;
  entry_config?: Record<string, unknown>; // 入口配置（平台不解析）
}

interface BusinessState {
  business_name: string;
  creator_id: string;
  on_failure: boolean;
  exit_bindings: ExitBinding[];
  prompt: string;
  model: string;
  agent_kind: string;
  package_asset_id?: string;
  entry_program?: string;
  tool_asset_ids: string[];
  skill_asset_ids: string[];
  timeout_minutes?: number;
  max_agent_calls?: number;
  matches: MatchState[];
}

function matchKey(source: EventSource, event_type: string): string {
  return `${source}__${event_type}`;
}

// 内存视图常驻（match 是热路径）；所有写操作 write-through：先事务落库，后更新内存
class SqliteBusinessRegistry implements BusinessRegistry {
  private readonly businesses = new Map<string, BusinessState>();
  private readonly view = new Map<string, BusinessMatch[]>();

  constructor(private readonly db: Database) {
    migrate(db, "registry", MIGRATIONS);
    this.loadAll();
  }

  private loadAll(): void {
    const businessRows = this.db.all<BusinessRow>(
      "SELECT business_id, business_name, creator_id, on_failure, exit_bindings, prompt, model, agent_kind, package_asset_id, entry_program, tool_asset_ids, skill_asset_ids, timeout_minutes, max_agent_calls FROM businesses",
    );
    for (const row of businessRows) {
      const state: BusinessState = {
        business_name: row.business_name,
        creator_id: row.creator_id,
        on_failure: row.on_failure !== 0,
        exit_bindings: JSON.parse(row.exit_bindings) as ExitBinding[],
        prompt: row.prompt,
        model: row.model,
        agent_kind: row.agent_kind,
        tool_asset_ids: JSON.parse(row.tool_asset_ids) as string[],
        skill_asset_ids: JSON.parse(row.skill_asset_ids) as string[],
        matches: [],
      };
      if (row.package_asset_id !== null)
        state.package_asset_id = row.package_asset_id;
      if (row.entry_program !== null) state.entry_program = row.entry_program;
      if (row.timeout_minutes !== null)
        state.timeout_minutes = row.timeout_minutes;
      if (row.max_agent_calls !== null)
        state.max_agent_calls = row.max_agent_calls;
      this.businesses.set(row.business_id, state);
    }
    const matchRows = this.db.all<MatchRow>(
      "SELECT business_id, source, event_type, entry_config FROM business_matches",
    );
    for (const row of matchRows) {
      const state = this.businesses.get(row.business_id);
      if (!state) continue; // 匹配行对应业务不存在则跳过（数据一致性兜底）
      const source = row.source as EventSource;
      const matchState: MatchState = { source, event_type: row.event_type };
      if (row.entry_config !== null) {
        matchState.entry_config = JSON.parse(row.entry_config) as Record<
          string,
          unknown
        >;
      }
      state.matches.push(matchState);
      this.pushViewRow(row.business_id, state, matchState);
    }
  }

  private makeRow(
    businessId: string,
    state: BusinessState,
    matchState: MatchState,
  ): BusinessMatch {
    const row: BusinessMatch = {
      business_id: businessId,
      business_name: state.business_name,
      creator_id: state.creator_id,
      source: matchState.source,
      event_type: matchState.event_type,
      on_failure: state.on_failure,
    };
    if (matchState.entry_config !== undefined) {
      row.entry_config = { ...matchState.entry_config };
    }
    return row;
  }

  private pushViewRow(
    businessId: string,
    state: BusinessState,
    matchState: MatchState,
  ): void {
    const key = matchKey(matchState.source, matchState.event_type);
    const rows = this.view.get(key);
    const row = this.makeRow(businessId, state, matchState);
    if (rows) {
      rows.push(row);
    } else {
      this.view.set(key, [row]);
    }
  }

  private removeFromView(businessId: string): void {
    const state = this.businesses.get(businessId);
    if (!state) return;
    for (const m of state.matches) {
      const key = matchKey(m.source, m.event_type);
      const rows = this.view.get(key);
      if (!rows) continue;
      const next = rows.filter((row) => row.business_id !== businessId);
      if (next.length === 0) {
        this.view.delete(key);
      } else {
        this.view.set(key, next);
      }
    }
  }

  private refreshView(businessId: string): void {
    const state = this.businesses.get(businessId);
    if (!state) return;
    this.removeFromView(businessId);
    for (const m of state.matches) {
      this.pushViewRow(businessId, state, m);
    }
  }

  match(source: EventSource, event_type: string): BusinessMatch[] {
    return [...(this.view.get(matchKey(source, event_type)) ?? [])];
  }

  exitBindings(business_id: string): ExitBinding[] {
    const state = this.businesses.get(business_id);
    if (!state) return [];
    return state.exit_bindings.map((binding) => ({
      ...binding,
      config: { ...binding.config },
    }));
  }

  get(business_id: string): BusinessMatch[] {
    const state = this.businesses.get(business_id);
    if (!state) return [];
    return state.matches.map((m) => this.makeRow(business_id, state, m));
  }

  getProfile(business_id: string): BusinessProfile | undefined {
    const state = this.businesses.get(business_id);
    if (!state) return undefined;
    const profile: BusinessProfile = {
      business_id,
      business_name: state.business_name,
      creator_id: state.creator_id,
      on_failure: state.on_failure,
      prompt: state.prompt,
      model: state.model,
      agent_kind: state.agent_kind,
      tool_asset_ids: [...state.tool_asset_ids],
      skill_asset_ids: [...state.skill_asset_ids],
    };
    if (state.package_asset_id !== undefined)
      profile.package_asset_id = state.package_asset_id;
    if (state.entry_program !== undefined)
      profile.entry_program = state.entry_program;
    if (state.timeout_minutes !== undefined)
      profile.timeout_minutes = state.timeout_minutes;
    if (state.max_agent_calls !== undefined)
      profile.max_agent_calls = state.max_agent_calls;
    return profile;
  }

  list(): BusinessProfile[] {
    return [...this.businesses.keys()]
      .sort()
      .map((id) => this.getProfile(id) as BusinessProfile);
  }

  create(input: CreateBusinessInput): string {
    const businessId = `b${newUlid()}`;
    const exitBindings: ExitBinding[] = (input.exit_bindings ?? []).map(
      (binding) => ({
        business_id: businessId,
        tool: binding.tool,
        config: { ...binding.config },
      }),
    );
    const toolAssetIds = [...(input.tool_asset_ids ?? [])];
    const skillAssetIds = [...(input.skill_asset_ids ?? [])];
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO businesses (business_id, business_name, creator_id, on_failure, exit_bindings, prompt, model, agent_kind, package_asset_id, entry_program, tool_asset_ids, skill_asset_ids, timeout_minutes, max_agent_calls) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          businessId,
          input.business_name,
          input.creator_id,
          input.on_failure ? 1 : 0,
          JSON.stringify(exitBindings),
          input.prompt ?? "",
          input.model ?? "",
          input.agent_kind ?? "pi",
          input.package_asset_id ?? null,
          input.entry_program ?? null,
          JSON.stringify(toolAssetIds),
          JSON.stringify(skillAssetIds),
          input.timeout_minutes ?? null,
          input.max_agent_calls ?? null,
        ],
      );
      this.db.run(
        "INSERT INTO business_matches (business_id, source, event_type) VALUES (?, ?, ?)",
        [businessId, input.source, input.event_type],
      );
    });
    const state: BusinessState = {
      business_name: input.business_name,
      creator_id: input.creator_id,
      on_failure: input.on_failure ?? false,
      exit_bindings: exitBindings,
      prompt: input.prompt ?? "",
      model: input.model ?? "",
      agent_kind: input.agent_kind ?? "pi",
      tool_asset_ids: toolAssetIds,
      skill_asset_ids: skillAssetIds,
      matches: [{ source: input.source, event_type: input.event_type }],
    };
    if (input.package_asset_id !== undefined)
      state.package_asset_id = input.package_asset_id;
    if (input.entry_program !== undefined)
      state.entry_program = input.entry_program;
    if (input.timeout_minutes !== undefined)
      state.timeout_minutes = input.timeout_minutes;
    if (input.max_agent_calls !== undefined)
      state.max_agent_calls = input.max_agent_calls;
    this.businesses.set(businessId, state);
    this.pushViewRow(businessId, state, state.matches[0]);
    return businessId;
  }

  update(business_id: string, patch: BusinessPatch): void {
    const state = this.businesses.get(business_id);
    if (!state) {
      throw new Error(`registry: 业务不存在: ${business_id}`);
    }
    const nextName = patch.business_name ?? state.business_name;
    const nextOnFailure = patch.on_failure ?? state.on_failure;
    const nextExitBindings = patch.exit_bindings
      ? patch.exit_bindings.map((binding) => ({
          ...binding,
          config: { ...binding.config },
        }))
      : state.exit_bindings;
    const nextPrompt = patch.prompt ?? state.prompt;
    const nextModel = patch.model ?? state.model;
    const nextAgentKind = patch.agent_kind ?? state.agent_kind;
    const nextPackageAssetId = patch.package_asset_id ?? state.package_asset_id;
    const nextEntryProgram = patch.entry_program ?? state.entry_program;
    const nextToolAssetIds = patch.tool_asset_ids
      ? [...patch.tool_asset_ids]
      : state.tool_asset_ids;
    const nextSkillAssetIds = patch.skill_asset_ids
      ? [...patch.skill_asset_ids]
      : state.skill_asset_ids;
    // quota 覆盖：undefined = 不动；null = 清除覆盖（落库 NULL）；number = 设置
    const nextTimeoutMinutes =
      patch.timeout_minutes === undefined
        ? state.timeout_minutes
        : (patch.timeout_minutes ?? undefined);
    const nextMaxAgentCalls =
      patch.max_agent_calls === undefined
        ? state.max_agent_calls
        : (patch.max_agent_calls ?? undefined);
    this.db.transaction(() => {
      this.db.run(
        "UPDATE businesses SET business_name = ?, on_failure = ?, exit_bindings = ?, prompt = ?, model = ?, agent_kind = ?, package_asset_id = ?, entry_program = ?, tool_asset_ids = ?, skill_asset_ids = ?, timeout_minutes = ?, max_agent_calls = ? WHERE business_id = ?",
        [
          nextName,
          nextOnFailure ? 1 : 0,
          JSON.stringify(nextExitBindings),
          nextPrompt,
          nextModel,
          nextAgentKind,
          nextPackageAssetId ?? null,
          nextEntryProgram ?? null,
          JSON.stringify(nextToolAssetIds),
          JSON.stringify(nextSkillAssetIds),
          nextTimeoutMinutes ?? null,
          nextMaxAgentCalls ?? null,
          business_id,
        ],
      );
    });
    state.business_name = nextName;
    state.on_failure = nextOnFailure;
    state.exit_bindings = nextExitBindings;
    state.prompt = nextPrompt;
    state.model = nextModel;
    state.agent_kind = nextAgentKind;
    state.package_asset_id = nextPackageAssetId;
    state.entry_program = nextEntryProgram;
    state.tool_asset_ids = nextToolAssetIds;
    state.skill_asset_ids = nextSkillAssetIds;
    state.timeout_minutes = nextTimeoutMinutes;
    state.max_agent_calls = nextMaxAgentCalls;
    this.refreshView(business_id);
  }

  addMatch(
    business_id: string,
    source: EventSource,
    event_type: string,
    entry_config?: Record<string, unknown>,
  ): void {
    const state = this.businesses.get(business_id);
    if (!state) {
      throw new Error(`registry: 业务不存在: ${business_id}`);
    }
    const exists = state.matches.some(
      (m) => m.source === source && m.event_type === event_type,
    );
    if (exists) return;
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO business_matches (business_id, source, event_type, entry_config) VALUES (?, ?, ?, ?)",
        [
          business_id,
          source,
          event_type,
          entry_config !== undefined ? JSON.stringify(entry_config) : null,
        ],
      );
    });
    const matchState: MatchState = { source, event_type };
    if (entry_config !== undefined)
      matchState.entry_config = { ...entry_config };
    state.matches.push(matchState);
    this.pushViewRow(business_id, state, matchState);
  }

  removeMatch(
    business_id: string,
    source: EventSource,
    event_type: string,
  ): void {
    const state = this.businesses.get(business_id);
    if (!state) return;
    const index = state.matches.findIndex(
      (m) => m.source === source && m.event_type === event_type,
    );
    if (index < 0) return;
    this.db.transaction(() => {
      this.db.run(
        "DELETE FROM business_matches WHERE business_id = ? AND source = ? AND event_type = ?",
        [business_id, source, event_type],
      );
    });
    // 视图行携带业务级字段快照：先整组移除，再按剩余匹配行重建
    this.removeFromView(business_id);
    state.matches.splice(index, 1);
    for (const m of state.matches) {
      this.pushViewRow(business_id, state, m);
    }
  }

  remove(business_id: string): void {
    if (!this.businesses.has(business_id)) return;
    this.db.transaction(() => {
      this.db.run("DELETE FROM business_matches WHERE business_id = ?", [
        business_id,
      ]);
      this.db.run("DELETE FROM businesses WHERE business_id = ?", [
        business_id,
      ]);
    });
    this.removeFromView(business_id);
    this.businesses.delete(business_id);
  }
}

/** 创建注册表。启动时从 SQLite 加载全量匹配行进内存视图 */
export function createBusinessRegistry(db: Database): BusinessRegistry {
  return new SqliteBusinessRegistry(db);
}
