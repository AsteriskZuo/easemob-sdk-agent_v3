import type { EventSource } from "@easemob/agent-contracts";
import type { AssetKind } from "@easemob/agent-asset-registry";
import type { ConfigField } from "@easemob/agent-exit-tools";
import type {
  BusinessMatch,
  BusinessProfile,
  ExitBinding,
} from "@easemob/agent-registry";
import type { Role, User } from "./accounts.js";

// ---------------------------------------------------------------------------
// 请求体 DTO（console T14 以 import type 复用；全部字段注释即表单语义）
// ---------------------------------------------------------------------------

/** POST /api/auth/login 请求体 */
export interface LoginBody {
  /** 登录名 */
  username: string;
  /** 明文密码（传输层安全由部署层负责） */
  password: string;
}

/** POST /api/users 请求体（仅 admin） */
export interface CreateUserBody {
  /** 登录名，唯一，创建后不可改 */
  username: string;
  /** 展示名，可改 */
  display_name: string;
  /** 初始密码（服务端 scrypt 散列存储，不明文落库） */
  password: string;
  /** 角色：admin = 平台管理；member = 业务/资产操作者 */
  role: Role;
}

/** POST /api/users/:id/disabled 请求体 */
export interface SetDisabledBody {
  /** true = 停用（不删行），false = 启用 */
  disabled: boolean;
}

/** POST /api/auth/change-password 请求体（本人） */
export interface ChangePasswordBody {
  /** 旧密码（校验失败 400） */
  old_password: string;
  /** 新密码（成功后该用户全部会话失效，需重新登录） */
  new_password: string;
}

/** POST /api/businesses 请求体。API 层只强校验 business_name/source/event_type；
 *  「包绑定/总纲必填」是 console UI 的表单职责，不在 API 强制 */
export interface CreateBusinessBody {
  /** 展示名（可改，不参与匹配） */
  business_name: string;
  /** 首个匹配行来源 */
  source: EventSource;
  /** 首个匹配行事件类型 */
  event_type: string;
  /** 首个匹配行的入口配置（平台不解析、原样存储透传） */
  entry_config?: Record<string, unknown>;
  /** 失败也扇出开关，缺省 false */
  on_failure?: boolean;
  /** 提示词总纲，缺省 '' */
  prompt?: string;
  /** 大模型选择：provider/id 形式；缺省 '' = 未选择（console 表单必选，API 不强制但做合法性校验，见绑定校验） */
  model?: string;
  /** agent 内核，缺省 'pi' */
  agent_kind?: string;
  /** 绑定的包资产 id */
  package_asset_id?: string;
  /** 流程程序入口名（包清单 programs 的键） */
  entry_program?: string;
  /** 绑定的工具资产 id 列表 */
  tool_asset_ids?: string[];
  /** 绑定的 skill 集合资产 id 列表 */
  skill_asset_ids?: string[];
  /** run 超时覆盖（分钟） */
  timeout_minutes?: number;
  /** agent 调用次数配额覆盖 */
  max_agent_calls?: number;
  /** 出口绑定（config 只存非机密项；机密项写业务层安全桶） */
  exit_bindings?: Array<{ tool: string; config: Record<string, string> }>;
}

/** PATCH /api/businesses/:id 请求体：BusinessPatch 同形（白名单外字段 400） */
export interface PatchBusinessBody {
  /** 展示名 */
  business_name?: string;
  /** 失败也扇出开关 */
  on_failure?: boolean;
  /** 出口绑定（全量替换） */
  exit_bindings?: Array<{ tool: string; config: Record<string, string> }>;
  /** 提示词总纲 */
  prompt?: string;
  /** 大模型选择 */
  model?: string;
  /** agent 内核 */
  agent_kind?: string;
  /** 包资产绑定 */
  package_asset_id?: string;
  /** 流程程序入口名 */
  entry_program?: string;
  /** 工具资产绑定（全量替换） */
  tool_asset_ids?: string[];
  /** skill 集合资产绑定（全量替换） */
  skill_asset_ids?: string[];
  /** run 超时覆盖；显式 null = 清除覆盖（回全局默认） */
  timeout_minutes?: number | null;
  /** agent 调用次数配额覆盖；显式 null = 清除覆盖 */
  max_agent_calls?: number | null;
}

/** POST /api/businesses/:id/matches 请求体 */
export interface MatchBody {
  /** 匹配行来源 */
  source: EventSource;
  /** 匹配行事件类型 */
  event_type: string;
  /** 入口配置（平台不解析、原样存储透传） */
  entry_config?: Record<string, unknown>;
}

/** DELETE /api/businesses/:id/matches 请求体（DELETE 用 body 传，不用 query） */
export interface RemoveMatchBody {
  /** 匹配行来源 */
  source: EventSource;
  /** 匹配行事件类型 */
  event_type: string;
}

/** POST /api/assets 请求体（仅 member；owner_id = 操作者本人）。
 *  私有资产凭据约定：is_private 资产的凭据值从通用层安全桶解析
 *  （env.getFor("").secrets[credential_key]），API 只收 key 名不收值；
 *  取不到 → 400（先在通用配置安全桶登记该 credential_key） */
export interface RegisterAssetBody {
  /** 资产类别 */
  kind: AssetKind;
  /** git 仓库地址（本地路径亦可） */
  url: string;
  /** 分支/tag/commit；登记时解析成 commit 存定 */
  ref: string;
  /** 资产根在仓库内的子路径（相对路径；缺省 = 仓库根） */
  subpath?: string;
  /** 仅 tool/skill 有意义（package 传 true → 400），缺省 false */
  shared?: boolean;
  /** 私有仓库标记，缺省 false；true 时 credential_key 必填 */
  is_private?: boolean;
  /** 凭据 key 名（指向通用层安全桶的键） */
  credential_key?: string;
}

/** PUT /api/env/global 与 PUT /api/env/businesses/:id 请求体 */
export interface EnvSetBody {
  /** 桶：vars = 普通桶（明文回显）；secrets = 安全桶（只写，list 只见键名） */
  bucket: "vars" | "secrets";
  /** 配置键（非空、不含首尾空白） */
  key: string;
  /** 配置值 */
  value: string;
}

/** DELETE /api/env/global 与 DELETE /api/env/businesses/:id 请求体 */
export interface EnvRemoveBody {
  /** 桶 */
  bucket: "vars" | "secrets";
  /** 配置键 */
  key: string;
}

// ---------------------------------------------------------------------------
// 聚合响应 DTO
// ---------------------------------------------------------------------------

/** POST /api/auth/login 201 响应（token 经 Set-Cookie 下发，不进 body） */
export interface LoginResult {
  /** 当前登录用户 */
  user: User;
  /** 会话过期时间（ISO；固定 7 天，不滑动续期） */
  expires_at: string;
}

/** GET /api/businesses/:id 响应：业务详情 = 资料 + 匹配行 + 出口绑定 */
export interface BusinessDetail {
  /** 业务资料（业务级字段完整读面） */
  profile: BusinessProfile;
  /** 全部匹配行 */
  matches: BusinessMatch[];
  /** 出口绑定 */
  exit_bindings: ExitBinding[];
}

/** GET /api/env/global 与 GET /api/env/businesses/:id 响应：
 *  secrets 只回键名（掩码回显归 console 渲染） */
export interface EnvListView {
  /** 普通桶明文键值 */
  vars: Record<string, string>;
  /** 安全桶键名（不含值） */
  secret_keys: string[];
}

/** GET /api/exit-tools 响应项：出口工具菜单（console 据此渲染表单；
 *  secret=true 的项写安全桶、非 secret 项进 ExitBinding.config） */
export interface ExitToolMenuItem {
  /** 工具标识（ExitBinding.tool 取值） */
  kind: string;
  /** 展示名 */
  name: string;
  /** false = 占位（菜单可见但不可实际投递） */
  implemented: boolean;
  /** 配置项声明 */
  configSchema: ConfigField[];
}

/** 单队列状态计数 */
export interface QueueCounts {
  /** 待取 */
  pending: number;
  /** 消化中 */
  processing: number;
  /** 完结 */
  done: number;
  /** 死信 */
  dead: number;
}

/** GET /api/monitor/queues 响应：两队列状态计数 */
export interface QueuesStatus {
  /** 入口队列（entry_tasks） */
  entry: QueueCounts;
  /** 出口队列（exit_tasks） */
  exit: QueueCounts;
}

/** 统一错误体 */
export interface ApiErrorBody {
  error: {
    /** 错误码（invalid_input/unauthenticated/forbidden/not_found/conflict/payload_too_large/internal） */
    code: string;
    /** 人类可读消息（internal 统一「内部错误」，不外泄细节） */
    message: string;
  };
}

/** 回显给控制台的生效配置（ServerConfig 的非敏感子集，装配层负责映射）。
 *  只读：改全局参数 = 改环境变量/{workspace}/config.json 后重启（ConfigStore 后续单独立项） */
export interface EffectiveConfigView {
  /** 平台工作目录 */
  workspace: string;
  /** 系统级日志级别 */
  log_level: string;
  /** 系统级日志开关 */
  log_enabled: boolean;
  /** 派生事件 hop 上限 */
  hop_limit: number;
  /** 入口业务闸门 */
  task_concurrency: number;
  /** 出口闸门 */
  result_concurrency: number;
  /** run 超时全局默认（分钟） */
  task_timeout_minutes: number;
  /** agent 调用配额全局默认 */
  max_agent_calls: number;
  /** pi 可执行文件绝对路径（非机密，原样回显） */
  pi_cli_path: string;
  /** PI_CODING_AGENT_DIR（非机密，原样回显） */
  pi_agent_dir: string;
  /** 可选大模型列表（provider/id 形式）：server 启动时解析 pi_agent_dir/models.json 所得全量 */
  models: string[];
  /** 可选 agent 内核列表（MVP 恒 ['pi']） */
  agents: string[];
}
