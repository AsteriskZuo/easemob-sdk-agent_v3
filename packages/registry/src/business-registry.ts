import { migrate } from "@easemob/agent-database";
import type { Database } from "@easemob/agent-database";
import { newUlid } from "@easemob/agent-contracts";
import type { EventSource } from "@easemob/agent-contracts";

/** 匹配视图：注册表执行视图的一行。无 order/depends_on 字段——链内并行，
 *  顺序靠事件订阅表达 */
export interface BusinessMatch {
  business_id: string; // 创建时生成、不可修改，一切内部引用的锚
  business_name: string; // 展示名，可修改，不参与匹配
  creator_id: string; // 创建者，不可修改（权限归属判定用）
  source: EventSource; // 关注的来源（行级）
  event_type: string; // 关注的事件类型（行级）
  on_failure?: boolean; // 失败也扇出；默认 false
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
}

/** 创建业务输入（含首个匹配行） */
export interface CreateBusinessInput {
  business_name: string; // 展示名，可修改
  creator_id: string; // 创建者账号 id，不可修改（权限归属判定用）
  source: EventSource; // 首个匹配行
  event_type: string;
  on_failure?: boolean; // 缺省 false
  exit_bindings?: Array<{ tool: string; config: Record<string, string> }>; // 缺省无绑定
}

export interface BusinessRegistry {
  /** 入口循环订阅匹配（热路径，走内存视图）；无关注者返回空数组 */
  match(source: EventSource, event_type: string): BusinessMatch[];

  /** 出口循环归属匹配：产出方业务的全部出口绑定；无绑定返回空数组 */
  exitBindings(business_id: string): ExitBinding[];

  /** 取业务的全部匹配行（一对多）；业务不存在返回空数组 */
  get(business_id: string): BusinessMatch[];

  /** 更新业务级字段（对该业务所有行生效）；业务不存在抛错 */
  update(business_id: string, patch: BusinessPatch): void;

  /** 创建业务（含首个匹配行），返回 business_id */
  create(input: CreateBusinessInput): string;

  /** 增删匹配行 = 增删入口/关注。addMatch 重复 (business_id,source,event_type) 幂等不报错 */
  addMatch(business_id: string, source: EventSource, event_type: string): void;
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
];

interface BusinessRow {
  business_id: string;
  business_name: string;
  creator_id: string;
  on_failure: number;
  exit_bindings: string;
}

interface MatchRow {
  business_id: string;
  source: string;
  event_type: string;
}

interface BusinessState {
  business_name: string;
  creator_id: string;
  on_failure: boolean;
  exit_bindings: ExitBinding[];
  matches: Array<{ source: EventSource; event_type: string }>;
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
      "SELECT business_id, business_name, creator_id, on_failure, exit_bindings FROM businesses",
    );
    for (const row of businessRows) {
      this.businesses.set(row.business_id, {
        business_name: row.business_name,
        creator_id: row.creator_id,
        on_failure: row.on_failure !== 0,
        exit_bindings: JSON.parse(row.exit_bindings) as ExitBinding[],
        matches: [],
      });
    }
    const matchRows = this.db.all<MatchRow>(
      "SELECT business_id, source, event_type FROM business_matches",
    );
    for (const row of matchRows) {
      const state = this.businesses.get(row.business_id);
      if (!state) continue; // 匹配行对应业务不存在则跳过（数据一致性兜底）
      const source = row.source as EventSource;
      state.matches.push({ source, event_type: row.event_type });
      this.pushViewRow(row.business_id, state, source, row.event_type);
    }
  }

  private makeRow(
    businessId: string,
    state: BusinessState,
    source: EventSource,
    event_type: string,
  ): BusinessMatch {
    return {
      business_id: businessId,
      business_name: state.business_name,
      creator_id: state.creator_id,
      source,
      event_type,
      on_failure: state.on_failure,
    };
  }

  private pushViewRow(
    businessId: string,
    state: BusinessState,
    source: EventSource,
    event_type: string,
  ): void {
    const key = matchKey(source, event_type);
    const rows = this.view.get(key);
    const row = this.makeRow(businessId, state, source, event_type);
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
      this.pushViewRow(businessId, state, m.source, m.event_type);
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
    return state.matches.map((m) =>
      this.makeRow(business_id, state, m.source, m.event_type),
    );
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
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO businesses (business_id, business_name, creator_id, on_failure, exit_bindings) VALUES (?, ?, ?, ?, ?)",
        [
          businessId,
          input.business_name,
          input.creator_id,
          input.on_failure ? 1 : 0,
          JSON.stringify(exitBindings),
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
      matches: [{ source: input.source, event_type: input.event_type }],
    };
    this.businesses.set(businessId, state);
    this.pushViewRow(businessId, state, input.source, input.event_type);
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
    this.db.transaction(() => {
      this.db.run(
        "UPDATE businesses SET business_name = ?, on_failure = ?, exit_bindings = ? WHERE business_id = ?",
        [
          nextName,
          nextOnFailure ? 1 : 0,
          JSON.stringify(nextExitBindings),
          business_id,
        ],
      );
    });
    state.business_name = nextName;
    state.on_failure = nextOnFailure;
    state.exit_bindings = nextExitBindings;
    this.refreshView(business_id);
  }

  addMatch(business_id: string, source: EventSource, event_type: string): void {
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
        "INSERT INTO business_matches (business_id, source, event_type) VALUES (?, ?, ?)",
        [business_id, source, event_type],
      );
    });
    state.matches.push({ source, event_type });
    this.pushViewRow(business_id, state, source, event_type);
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
      this.pushViewRow(business_id, state, m.source, m.event_type);
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
