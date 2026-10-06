export { createConsoleApi } from "./server.js";
export type {
  ConsoleApi,
  ConsoleApiDeps,
  ConsoleApiOptions,
} from "./server.js";
export { createAccountService } from "./accounts.js";
export type { AccountService, Role, User } from "./accounts.js";
export { ApiError, statusOf, toApiError } from "./errors.js";
export type { ApiErrorCode } from "./errors.js";
export type * from "./dto.js";

// 上游类型 type-only 再导出：console（T14）只依赖本包即可拿到全部 API 契约类型
export type { EventSource, EventEnvelope } from "@easemob/agent-contracts";
export type {
  AssetInput,
  AssetKind,
  AssetManifest,
  AssetMeta,
  AssetObject,
} from "@easemob/agent-asset-registry";
export type {
  BusinessMatch,
  BusinessPatch,
  BusinessProfile,
  ExitBinding,
} from "@easemob/agent-registry";
export type { ConfigField } from "@easemob/agent-exit-tools";
export type { Task, TaskStatus } from "@easemob/agent-queue";
export type { LifecycleRecord, LifecycleStatus } from "@easemob/agent-runtime";
