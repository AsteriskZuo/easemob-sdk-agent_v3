import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Switch,
  Table,
  Tabs,
  Tag,
} from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import { Link, useNavigate, useParams } from "react-router-dom";
import type {
  AssetManifest,
  AssetMeta,
  BusinessDetail,
  BusinessProfile,
  CreateBusinessBody,
  EffectiveConfigView,
  EntryAdapterView,
  ExitToolMenuItem,
  HandbookPage,
  LifecycleStatus,
  MatchBody,
  PatchBusinessBody,
  TaskView,
} from "@asteriskzuo/agent-console-api";
import {
  apiFetch,
  ApiError,
  listScheduledTasks,
  runScheduledTask,
} from "../api/client";
import CreateEnvEditor from "../components/CreateEnvEditor";
import type { EnvKvRow } from "../components/CreateEnvEditor";
import EnvEditor from "../components/EnvEditor";
import type { EnvEditorHandle } from "../components/EnvEditor";
import MatchEditor, {
  parseEntryConfig,
  toMatchBody,
} from "../components/MatchEditor";
import type { MatchRow } from "../components/MatchEditor";
import EffectivenessNote from "../components/EffectivenessNote";
import PiConfigSection from "../components/PiConfigSection";
import SectionHelp from "../components/SectionHelp";
import { handbookBody } from "../handbook";
import { RUN_STATUS_COLOR } from "../run-columns";

/** 表单字段（antd Form 承载的部分；匹配行与出口配置走独立 state） */
interface BusinessFormValues {
  business_name: string;
  package_asset_id: string;
  entry_program: string;
  tool_asset_ids?: string[];
  skill_asset_ids?: string[];
  agent_kind: string;
  prompt?: string;
  on_failure: boolean;
  timeout_minutes?: number | null;
  max_agent_calls?: number | null;
}

/** 解析出口绑定配置文本（复用入口的 JSON object 解析：空 → undefined；非法 → null） */
const parseExitConfigText = parseEntryConfig;

/** 创建页草稿的 localStorage 键（版本号在键名里：结构变化直接换键，不做迁移） */
const CREATE_DRAFT_KEY = "business-create-draft-v1";

/** 创建页草稿：表单全量状态（antd Form 字段 + 匹配行 + 出口勾选/配置文本 + 随建环境配置行） */
interface CreateDraft {
  /** antd Form 承载的字段（业务名/agent/资产绑定/超时覆盖等） */
  form: Partial<BusinessFormValues>;
  /** 匹配行 */
  matches: MatchRow[];
  /** 出口工具勾选态 */
  checkedExits: Record<string, boolean>;
  /** 出口配置 JSON 文本 */
  exitConfigTexts: Record<string, string>;
  /** 随建普通变量行 */
  envVars: EnvKvRow[];
  /** 随建安全变量行 */
  envSecrets: EnvKvRow[];
}

/** 读草稿：无/非法 JSON → undefined（结构变更靠换键名隔离，不做迁移） */
function loadCreateDraft(): CreateDraft | undefined {
  try {
    const raw = localStorage.getItem(CREATE_DRAFT_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as CreateDraft;
  } catch {
    return undefined;
  }
}

/** 首个匹配行的初始空态（重置草稿时也回到它） */
const EMPTY_MATCH_ROW: MatchRow = {
  source: "manual",
  event_type: "",
  entry_config_text: "",
};

/** 随建环境配置行 → POST body 的 env 字段（key 空白的行丢弃；两组皆空 → undefined 不携带） */
function buildEnvBody(
  envVars: EnvKvRow[],
  envSecrets: EnvKvRow[],
):
  | { vars?: Record<string, string>; secrets?: Record<string, string> }
  | undefined {
  const vars: Record<string, string> = {};
  for (const row of envVars) {
    const key = row.key.trim();
    if (key !== "") vars[key] = row.value;
  }
  const secrets: Record<string, string> = {};
  for (const row of envSecrets) {
    const key = row.key.trim();
    if (key !== "") secrets[key] = row.value;
  }
  if (Object.keys(vars).length === 0 && Object.keys(secrets).length === 0) {
    return undefined;
  }
  return {
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
  };
}

/** 出口表单字段值回写进配置 JSON 文本（空串 = 删键；全部键删光 = 回到空文本） */
function withExitConfigValue(text: string, key: string, value: string): string {
  const parsed = parseExitConfigText(text);
  const base: Record<string, unknown> =
    parsed.ok && parsed.value !== undefined ? { ...parsed.value } : {};
  if (value.trim() === "") {
    delete base[key];
  } else {
    base[key] = value;
  }
  return Object.keys(base).length > 0 ? JSON.stringify(base) : "";
}

/** 取出口配置项当前值（字符串原样；其他 JSON 值字符串化展示） */
function exitConfigFieldValue(text: string, key: string): string {
  const parsed = parseExitConfigText(text);
  if (!parsed.ok || parsed.value === undefined) return "";
  const value = parsed.value[key];
  if (value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** 出口 JSON 视图空绑定预填模板：schema 字段全列出，secret 项给 {{key}} 占位示例 */
function exitConfigTemplate(tool: ExitToolMenuItem): string {
  const template: Record<string, string> = {};
  for (const field of tool.configSchema) {
    template[field.key] =
      field.placeholder ?? (field.secret === true ? `{{${field.key}}}` : "");
  }
  return JSON.stringify(template, null, 2);
}

/** 平滑滚动到指定区块（保存报错定位 / 顶部状态条锚点导航共用）。
 *  jsdom 未实现 scrollIntoView，方法级可选调用兜底测试环境 */
function scrollToSection(domId: string) {
  document.getElementById(domId)?.scrollIntoView?.({
    behavior: "smooth",
    block: "start",
  });
}

/** 状态点颜色：ok=已配置（绿）/ warn=待完善（黄）/ plain=可选或未涉及（蓝；灰色留给「不可用」语义） */
type SectionStatus = { kind: "ok" | "warn" | "plain"; text: string };

const STATUS_COLORS: Record<SectionStatus["kind"], string> = {
  ok: "#52c41a",
  warn: "#faad14",
  plain: "#1677ff",
};

/** 出口「期望返回形状」抽屉按钮（resultDoc 较长，从卡内移入抽屉） */
function ResultDocButton({ toolName, doc }: { toolName: string; doc: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="link"
        size="small"
        style={{ padding: 0 }}
        onClick={() => setOpen(true)}
      >
        查看该出口期望 sdk.return 返回的形状
      </Button>
      <Drawer
        title={`${toolName} · 期望的返回形状`}
        placement="right"
        width={520}
        open={open}
        onClose={() => setOpen(false)}
      >
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 12,
            lineHeight: 1.7,
            fontFamily: "monospace",
          }}
        >
          {doc}
        </pre>
      </Drawer>
    </>
  );
}

/** 业务创建/编辑同体页（/businesses/new 与 /businesses/:id 共用）。
 *  主保存按钮（页面最底部）统一完成：registry 字段 PATCH + 匹配行 diff + 出口绑定整体覆盖
 *  （出口配置全字段原样进 ExitBinding.config，含 {{key}} 占位文本，不再拆写安全桶）
 *  + 编辑模式的业务 key-value 草稿（EnvEditor ref.save()，独立请求序列不并入 PATCH body）。
 *  仅创建模式：表单全量状态防抖 500ms 落 localStorage 草稿（CREATE_DRAFT_KEY），
 *  重进恢复 + 可手动清除，提交成功自动清除；编辑模式不做草稿（已有服务端数据） */
export default function BusinessEditPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = id !== undefined;
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<BusinessFormValues>();

  // 创建模式挂载时读一次草稿（编辑模式不读；undefined = 无草稿/草稿损坏）
  const [initialDraft] = useState<CreateDraft | undefined>(() =>
    isEdit ? undefined : loadCreateDraft(),
  );
  const [draftRestored, setDraftRestored] = useState(
    initialDraft !== undefined,
  );

  const [loading, setLoading] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);
  const [matches, setMatches] = useState<MatchRow[]>(() =>
    initialDraft !== undefined &&
    Array.isArray(initialDraft.matches) &&
    initialDraft.matches.length > 0
      ? initialDraft.matches
      : [EMPTY_MATCH_ROW],
  );
  // 编辑态原始匹配行（保存时做增删 diff 的基准；key = `${source}\n${event_type}`）
  const [originalMatches, setOriginalMatches] = useState<MatchRow[]>([]);
  const [exitTools, setExitTools] = useState<ExitToolMenuItem[]>([]);
  const [checkedExits, setCheckedExits] = useState<Record<string, boolean>>(
    () => initialDraft?.checkedExits ?? {},
  );
  /** 出口绑定配置的 JSON 文本（唯一事实源；「表单」/「JSON」双视图都编辑它） */
  const [exitConfigTexts, setExitConfigTexts] = useState<
    Record<string, string>
  >(() => initialDraft?.exitConfigTexts ?? {});
  // 随建环境配置（仅创建模式渲染；状态进草稿）
  const [envVars, setEnvVars] = useState<EnvKvRow[]>(
    () => initialDraft?.envVars ?? [],
  );
  const [envSecrets, setEnvSecrets] = useState<EnvKvRow[]>(
    () => initialDraft?.envSecrets ?? [],
  );
  // 编辑模式的环境配置草稿（EnvEditor 自管加载/diff；主「保存」经 ref 统一触发）
  const envEditorRef = useRef<EnvEditorHandle>(null);
  const [packages, setPackages] = useState<AssetMeta[]>([]);
  const [tools, setTools] = useState<AssetMeta[]>([]);
  const [skills, setSkills] = useState<AssetMeta[]>([]);
  const [entryPrograms, setEntryPrograms] = useState<string[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  // 入口适配器自描述（/api/config 的 entry_adapters）：MatchEditor 事件文档与 entry_config 表单数据源
  const [entryAdapters, setEntryAdapters] = useState<EntryAdapterView[]>([]);
  // 现有业务列表：source=internal 的「上游业务」下拉数据源
  const [businesses, setBusinesses] = useState<BusinessProfile[]>([]);
  // 编辑态失效侦测：profile 原值不在可选集合时保留显示并标黄
  const watchedAgentKind = Form.useWatch("agent_kind", form);
  // 全表单值监听（顶部状态条的实时状态判定）
  const formValues = Form.useWatch([], form);
  // 全局运行策略默认值（/api/config；运行策略区「继承可视化」用）
  const [globalDefaults, setGlobalDefaults] = useState<{
    task_timeout_minutes?: number;
    max_agent_calls?: number;
  }>({});
  // 编辑态回填基准：出口配置文本（脏判定用）
  const [originalExitTexts, setOriginalExitTexts] = useState<
    Record<string, string>
  >({});
  // 编辑态大模型配置状态（profile.model 非空 = 已配置；状态条判定用）
  const [modelConfigured, setModelConfigured] = useState(false);
  // 当前页面的 tip/drawer 内容唯一来源：handbook YAML → generated JSON → console-api
  const [handbook, setHandbook] = useState<HandbookPage>({});
  // 定时任务清单（仅编辑态；包清单 scheduled_tasks 声明驱动，spec 2026-11-13 D6）
  const [scheduledTasks, setScheduledTasks] = useState<TaskView[]>([]);
  // 「立即执行」按钮 loading 态（任务名；null = 无在飞点击）
  const [runningTaskName, setRunningTaskName] = useState<string | null>(null);

  const reportError = useCallback(
    (err: unknown, fallback: string) => {
      message.error(err instanceof ApiError ? err.message : fallback);
    },
    [message],
  );

  /** 加载定时任务清单（仅编辑态；无声明的业务返回空数组 → 区块不渲染） */
  const loadScheduledTasks = useCallback(async () => {
    if (!isEdit || id === undefined) return;
    try {
      const res = await listScheduledTasks(id);
      setScheduledTasks(res.tasks);
    } catch (err) {
      reportError(err, "加载定时任务失败");
    }
  }, [isEdit, id, reportError]);

  // 编辑态挂载时加载定时任务清单
  useEffect(() => {
    void loadScheduledTasks();
  }, [loadScheduledTasks]);

  /** 手动「立即执行」：202 = 已发起（执行在后台）；409 = 该任务正在运行；完成后刷新列表 */
  const runTask = useCallback(
    async (taskName: string) => {
      if (id === undefined) return;
      setRunningTaskName(taskName);
      try {
        await runScheduledTask(id, taskName);
        message.success(`已发起执行（任务 ${taskName}），运行记录稍后可见`);
      } catch (err) {
        if (err instanceof ApiError && err.code === "conflict") {
          message.warning("该任务正在运行");
        } else {
          reportError(err, "发起执行失败");
        }
      } finally {
        setRunningTaskName(null);
        void loadScheduledTasks();
      }
    },
    [id, message, reportError, loadScheduledTasks],
  );

  /** 选中包 → 拉详情取 manifest.programs 键列表（entry_program 下拉数据源） */
  const loadEntryPrograms = useCallback(
    async (assetId: string) => {
      try {
        const asset = await apiFetch<{ manifest: AssetManifest }>(
          `/api/assets/${assetId}`,
        );
        if (asset.manifest.kind === "package") {
          setEntryPrograms(Object.keys(asset.manifest.programs));
        } else {
          setEntryPrograms([]);
        }
      } catch (err) {
        reportError(err, "加载包清单失败（首次可能触发 git 克隆，较慢）");
      }
    },
    [reportError],
  );

  // ---- 创建草稿（仅创建模式）：任意表单状态变化 → 防抖 500ms 写 localStorage ----
  // 非 Form 状态的最新快照（防抖回调触发时读取，避免闭包拿旧值）
  const draftStateRef = useRef({
    matches,
    checkedExits,
    exitConfigTexts,
    envVars,
    envSecrets,
  });
  draftStateRef.current = {
    matches,
    checkedExits,
    exitConfigTexts,
    envVars,
    envSecrets,
  };
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 调度一次草稿写入（500ms 防抖；编辑模式直接忽略） */
  const scheduleDraftWrite = useCallback(() => {
    if (isEdit) return;
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    draftTimerRef.current = setTimeout(() => {
      draftTimerRef.current = null;
      const snapshot: CreateDraft = {
        form: form.getFieldsValue(),
        ...draftStateRef.current,
      };
      try {
        localStorage.setItem(CREATE_DRAFT_KEY, JSON.stringify(snapshot));
      } catch {
        // 存储不可用/超限：草稿是锦上添花，静默放弃
      }
    }, 500);
  }, [isEdit, form]);

  // 卸载时清掉未落盘的防抖计时器（避免向已卸载页面的 localStorage 迟到写入）
  useEffect(
    () => () => {
      if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current);
    },
    [],
  );

  // 草稿恢复：Form 字段需在挂载后回填；恢复包绑定后同步拉入口程序下拉
  useEffect(() => {
    if (isEdit || initialDraft === undefined) return;
    if (initialDraft.form !== undefined) {
      form.setFieldsValue(initialDraft.form);
      if (initialDraft.form.package_asset_id !== undefined) {
        void loadEntryPrograms(initialDraft.form.package_asset_id);
      }
    }
  }, [isEdit, initialDraft, form, loadEntryPrograms]);

  /** 清除草稿：删 localStorage + 表单与全部独立状态回到初始空态 */
  const clearDraft = useCallback(() => {
    if (draftTimerRef.current !== null) {
      clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    localStorage.removeItem(CREATE_DRAFT_KEY);
    setDraftRestored(false);
    form.resetFields();
    setMatches([EMPTY_MATCH_ROW]);
    setCheckedExits({});
    setExitConfigTexts({});
    setEnvVars([]);
    setEnvSecrets([]);
  }, [form]);

  // 初始加载：出口工具菜单 + 三类资产下拉数据源 + 可选内核/入口适配器清单 + 页面说明
  useEffect(() => {
    apiFetch<HandbookPage>("/api/handbook/business-edit")
      .then(setHandbook)
      .catch((err: unknown) => reportError(err, "加载页面说明失败"));
    apiFetch<ExitToolMenuItem[]>("/api/exit-tools")
      .then(setExitTools)
      .catch((err: unknown) => reportError(err, "加载出口工具失败"));
    apiFetch<AssetMeta[]>("/api/assets?kind=package&scope=mine")
      .then(setPackages)
      .catch((err: unknown) => reportError(err, "加载包资产失败"));
    apiFetch<AssetMeta[]>("/api/assets?kind=tool&scope=all")
      .then(setTools)
      .catch((err: unknown) => reportError(err, "加载工具资产失败"));
    apiFetch<AssetMeta[]>("/api/assets?kind=skill&scope=all")
      .then(setSkills)
      .catch((err: unknown) => reportError(err, "加载 skill 资产失败"));
    apiFetch<EffectiveConfigView>("/api/config")
      .then((config) => {
        setAgents(config.agents);
        setEntryAdapters(config.entry_adapters);
        setGlobalDefaults({
          task_timeout_minutes: config.task_timeout_minutes,
          max_agent_calls: config.max_agent_calls,
        });
        // 创建模式 agent 默认选中第一个可选项
        if (!isEdit && config.agents.length > 0) {
          if (form.getFieldValue("agent_kind") === undefined) {
            form.setFieldValue("agent_kind", config.agents[0]);
          }
        }
      })
      .catch((err: unknown) => reportError(err, "加载平台配置失败"));
    // 现有业务列表：internal 入口引导的「上游业务」下拉
    apiFetch<BusinessProfile[]>("/api/businesses")
      .then(setBusinesses)
      .catch((err: unknown) => reportError(err, "加载业务列表失败"));
  }, [reportError, isEdit, form]);

  // 编辑态：回填详情（出口绑定 config 原样回填为 JSON 文本，含 {{key}} 占位）
  useEffect(() => {
    if (!isEdit) return;
    setLoading(true);
    void (async () => {
      try {
        const detail = await apiFetch<BusinessDetail>(`/api/businesses/${id}`);
        const profile = detail.profile;
        form.setFieldsValue({
          business_name: profile.business_name,
          package_asset_id: profile.package_asset_id,
          entry_program: profile.entry_program,
          tool_asset_ids: profile.tool_asset_ids,
          skill_asset_ids: profile.skill_asset_ids,
          agent_kind: profile.agent_kind,
          prompt: profile.prompt,
          on_failure: profile.on_failure,
          timeout_minutes: profile.timeout_minutes ?? null,
          max_agent_calls: profile.max_agent_calls ?? null,
        });
        const rows: MatchRow[] = detail.matches.map((m) => ({
          source: m.source,
          event_type: m.event_type,
          entry_config_text:
            m.entry_config !== undefined
              ? JSON.stringify(m.entry_config, null, 2)
              : "",
        }));
        if (rows.length > 0) {
          setMatches(rows);
          setOriginalMatches(rows);
        }
        // 出口回填：config 原样回填为 JSON 文本（全字段含占位文本都在 binding.config 里）
        const checked: Record<string, boolean> = {};
        const texts: Record<string, string> = {};
        for (const binding of detail.exit_bindings) {
          checked[binding.tool] = true;
          texts[binding.tool] = JSON.stringify(binding.config, null, 2);
        }
        setCheckedExits(checked);
        setExitConfigTexts(texts);
        setOriginalExitTexts(texts);
        setModelConfigured(profile.model !== "");
        if (profile.package_asset_id !== undefined) {
          await loadEntryPrograms(profile.package_asset_id);
        }
      } catch (err) {
        reportError(err, "加载业务详情失败");
      } finally {
        setLoading(false);
      }
    })();
  }, [id, isEdit, form, loadEntryPrograms, reportError]);

  const assetOptions = useMemo(
    () => (list: AssetMeta[]) =>
      list.map((a) => ({ value: a.asset_id, label: a.asset_id })),
    [],
  );

  /** 出口表单字段值更新（回写进该工具的配置 JSON 文本） */
  const setExitConfigValue = (
    kind: string,
    fieldKey: string,
    value: string,
  ) => {
    setExitConfigTexts((prev) => ({
      ...prev,
      [kind]: withExitConfigValue(prev[kind] ?? "", fieldKey, value),
    }));
    scheduleDraftWrite();
  };

  /** 出口绑定构建：checked 工具的配置 JSON 文本 → ExitBinding.config。
   *  全字段（含 secret 标记项与 {{key}} 占位文本）原样进 config，不再拆写安全桶；
   *  非法 JSON / 必填缺失进 problems（逐条 message 拦截提交） */
  const buildExitBindings = (): {
    bindings: Array<{ tool: string; config: Record<string, string> }>;
    problems: string[];
  } => {
    const bindings: Array<{ tool: string; config: Record<string, string> }> =
      [];
    const problems: string[] = [];
    for (const tool of exitTools) {
      if (checkedExits[tool.kind] !== true) continue;
      const parsed = parseExitConfigText(exitConfigTexts[tool.kind] ?? "");
      if (!parsed.ok) {
        problems.push(`出口「${tool.name}」的配置不是合法 JSON object`);
        continue;
      }
      const config: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed.value ?? {})) {
        const text =
          typeof value === "string" ? value.trim() : JSON.stringify(value);
        if (text !== "") config[key] = text;
      }
      for (const field of tool.configSchema) {
        if (field.required === true && config[field.key] === undefined) {
          problems.push(`出口「${tool.name}」的必填项「${field.label}」未填写`);
        }
      }
      bindings.push({ tool: tool.kind, config });
    }
    return { bindings, problems };
  };

  /** 返回业务列表：创建态草稿已自动落 localStorage（重进可恢复，无损）直接返回；
   *  编辑态有未保存修改（表单字段 / 匹配行 / 出口配置）时弹确认 */
  const goBack = useCallback(() => {
    if (!isEdit) {
      navigate("/businesses");
      return;
    }
    const dirty =
      form.isFieldsTouched() ||
      JSON.stringify(matches) !== JSON.stringify(originalMatches) ||
      JSON.stringify(exitConfigTexts) !== JSON.stringify(originalExitTexts);
    if (!dirty) {
      navigate("/businesses");
      return;
    }
    Modal.confirm({
      title: "有未保存的修改",
      content: "离开后修改将丢失，确定返回业务列表？",
      okText: "放弃修改并返回",
      cancelText: "继续编辑",
      onOk: () => navigate("/businesses"),
    });
  }, [
    isEdit,
    navigate,
    form,
    matches,
    originalMatches,
    exitConfigTexts,
    originalExitTexts,
  ]);

  // 顶部状态条：七块配置完整性速览（能低本判定的实时判定，环境配置纯锚点）
  const checkedExitCount = Object.values(checkedExits).filter(Boolean).length;
  const hasRuntimeOverride =
    (formValues?.timeout_minutes ?? null) != null ||
    (formValues?.max_agent_calls ?? null) != null ||
    formValues?.on_failure === true;
  const sectionNav: Array<{
    id: string;
    label: string;
    status: SectionStatus;
  }> = [
    {
      id: "sec-model",
      label: "大模型",
      status: !isEdit
        ? { kind: "plain", text: "创建后配置" }
        : modelConfigured
          ? { kind: "ok", text: "已配置" }
          : { kind: "warn", text: "未配置" },
    },
    {
      id: "sec-prompt",
      label: "提示词",
      status:
        (formValues?.prompt ?? "").trim() !== ""
          ? { kind: "ok", text: "已填写" }
          : { kind: "plain", text: "未填写" },
    },
    {
      id: "sec-assets",
      label: "资产",
      status:
        formValues?.package_asset_id !== undefined &&
        formValues?.package_asset_id !== "" &&
        formValues?.entry_program !== undefined &&
        formValues?.entry_program !== ""
          ? { kind: "ok", text: "已绑定" }
          : { kind: "warn", text: "缺绑定" },
    },
    {
      id: "sec-entry",
      label: "入口",
      status: { kind: "ok", text: `${matches.length} 行` },
    },
    {
      id: "sec-exit",
      label: "出口",
      status:
        checkedExitCount > 0
          ? { kind: "ok", text: `${checkedExitCount} 个` }
          : { kind: "plain", text: "可选" },
    },
    {
      id: "sec-env",
      label: "环境配置",
      status: { kind: "plain", text: "·" },
    },
    {
      id: "sec-runtime",
      label: "运行策略",
      status: hasRuntimeOverride
        ? { kind: "ok", text: "自定义" }
        : { kind: "plain", text: "继承全局" },
    },
  ];

  const submit = async () => {
    let values: BusinessFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return; // 表单内已报错（Form scrollToFirstError 自动定位）
    }
    // 匹配行校验：全部行 JSON 合法（event_type 可留空 = 通配该来源全部事件）
    const matchBodies = matches.map(toMatchBody);
    if (matchBodies.some((b) => b === null)) {
      message.error("入口配置：匹配行的 JSON 不是合法 object，请修正后再提交");
      scrollToSection("sec-entry");
      return;
    }
    // 上面已拦截 null（非法 JSON），此处收窄
    const validMatchBodies = matchBodies as MatchBody[];
    const { bindings, problems } = buildExitBindings();
    if (problems.length > 0) {
      message.error(`出口配置：${problems[0]}`);
      scrollToSection("sec-exit");
      return;
    }

    setSubmitting(true);
    try {
      if (!isEdit) {
        // 创建：POST → 拿 business_id → 追加匹配行 → 跳编辑页
        const [firstBody, ...restBodies] = validMatchBodies;
        // 随建环境配置：两组皆空不携带 env（key 空白的行已丢弃）
        const env = buildEnvBody(envVars, envSecrets);
        const body: CreateBusinessBody = {
          business_name: values.business_name,
          source: firstBody.source,
          event_type: firstBody.event_type,
          ...(firstBody.entry_config !== undefined
            ? { entry_config: firstBody.entry_config }
            : {}),
          on_failure: values.on_failure,
          prompt: values.prompt ?? "",
          agent_kind: values.agent_kind,
          package_asset_id: values.package_asset_id,
          entry_program: values.entry_program,
          tool_asset_ids: values.tool_asset_ids ?? [],
          skill_asset_ids: values.skill_asset_ids ?? [],
          ...(values.timeout_minutes != null
            ? { timeout_minutes: values.timeout_minutes }
            : {}),
          ...(values.max_agent_calls != null
            ? { max_agent_calls: values.max_agent_calls }
            : {}),
          exit_bindings: bindings,
          ...(env !== undefined ? { env } : {}),
        };
        const created = await apiFetch<{ business_id: string }>(
          "/api/businesses",
          { method: "POST", body },
        );
        for (const matchBody of restBodies) {
          await apiFetch<void>(
            `/api/businesses/${created.business_id}/matches`,
            {
              method: "POST",
              body: matchBody,
            },
          );
        }
        // 提交成功 → 清除草稿
        localStorage.removeItem(CREATE_DRAFT_KEY);
        message.success("业务已创建");
        navigate(`/businesses/${created.business_id}`, { replace: true });
        return;
      }

      // 编辑：PATCH 资料字段（超时/配额清除 = null）+ 匹配行增删 diff + 出口绑定整体覆盖
      // （model 只读派生，不随 PATCH——由大模型配置区的验证-确认流程维护）
      const patch: PatchBusinessBody = {
        business_name: values.business_name,
        on_failure: values.on_failure,
        prompt: values.prompt ?? "",
        agent_kind: values.agent_kind,
        package_asset_id: values.package_asset_id,
        entry_program: values.entry_program,
        tool_asset_ids: values.tool_asset_ids ?? [],
        skill_asset_ids: values.skill_asset_ids ?? [],
        timeout_minutes: values.timeout_minutes ?? null,
        max_agent_calls: values.max_agent_calls ?? null,
        exit_bindings: bindings,
      };
      await apiFetch<void>(`/api/businesses/${id}`, {
        method: "PATCH",
        body: patch,
      });
      // 匹配行 diff（source+event_type+entry_config 三元组判等；变更 = 删旧增新）
      const keyOf = (row: MatchRow) =>
        `${row.source}\n${row.event_type}\n${row.entry_config_text.trim()}`;
      const originalKeys = new Set(originalMatches.map(keyOf));
      const currentKeys = new Set(matches.map(keyOf));
      for (const row of originalMatches) {
        if (!currentKeys.has(keyOf(row))) {
          await apiFetch<void>(`/api/businesses/${id}/matches`, {
            method: "DELETE",
            body: { source: row.source, event_type: row.event_type },
          });
        }
      }
      for (let i = 0; i < matches.length; i++) {
        if (!originalKeys.has(keyOf(matches[i]))) {
          await apiFetch<void>(`/api/businesses/${id}/matches`, {
            method: "POST",
            body: validMatchBodies[i],
          });
        }
      }
      // 环境配置草稿随主「保存」统一落库（EnvEditor 逐 key diff，不并入 PATCH body；
      // 失败时其内部已报错并把展示回滚为服务端状态——业务资料已存成，停留本页供修正重试）
      const envOk = (await envEditorRef.current?.save()) ?? true;
      if (!envOk) return;
      message.success("已保存");
      navigate("/businesses");
    } catch (err) {
      // 创建态占位校验 fail-fast（T24）：提示末尾引导到下方随建环境配置区补键重提
      if (
        !isEdit &&
        err instanceof ApiError &&
        err.message.includes("不存在的环境配置键")
      ) {
        message.error(
          `${err.message}；可在下方「环境配置」区补充缺失的键后重新提交`,
        );
      } else {
        reportError(err, "保存失败");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: 860 }}>
      {/* 页头：返回按钮单独一行（文字按钮弱化存在感），标题独占一行 */}
      <div style={{ marginBottom: 4 }}>
        <Button
          type="text"
          icon={<ArrowLeftOutlined />}
          aria-label="返回业务列表"
          onClick={goBack}
          style={{ padding: "4px 0", color: "#666" }}
        >
          返回
        </Button>
      </div>
      <h2 style={{ margin: "0 0 8px" }}>
        <SectionHelp
          title={isEdit ? "编辑业务" : "创建业务"}
          entries={handbook}
          drawerId="console.business-edit.overview"
        />
      </h2>

      {/* 顶部状态条：七块配置完整性速览 + 锚点导航（绿=已配置 黄=待完善 蓝=可选/未涉及） */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "6px 18px",
          padding: "8px 12px",
          marginBottom: 16,
          background: "#fafafa",
          border: "1px solid #f0f0f0",
          borderRadius: 8,
          fontSize: 13,
        }}
      >
        {sectionNav.map((s) => (
          <a
            key={s.id}
            aria-label={`跳转到${s.label}配置`}
            onClick={() => scrollToSection(s.id)}
            style={{ cursor: "pointer", color: "inherit" }}
          >
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: STATUS_COLORS[s.status.kind],
                marginRight: 6,
              }}
            />
            {s.label}
            <span style={{ color: "#999", marginLeft: 4 }}>
              {s.status.text}
            </span>
          </a>
        ))}
      </div>

      {!isEdit && draftRestored && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message="已恢复上次未完成的草稿"
          action={
            <Button size="small" onClick={clearDraft}>
              清除草稿
            </Button>
          }
        />
      )}
      <Form
        form={form}
        layout="vertical"
        disabled={loading}
        scrollToFirstError
        initialValues={{
          on_failure: false,
        }}
        onValuesChange={scheduleDraftWrite}
      >
        {/* 业务名：页头精简行（不套卡片；仅展示用，不参与事件匹配） */}
        <Form.Item
          name="business_name"
          rules={[
            { required: true, whitespace: true, message: "业务名称不能为空" },
          ]}
          style={{ marginBottom: 16 }}
        >
          <Input
            aria-label="业务名称"
            size="large"
            placeholder="业务名称，如：代码评审助手"
          />
        </Form.Item>

        <div id="sec-model">
          <Card
            title={
              <SectionHelp
                title="大模型配置"
                entries={handbook}
                tipId="console.business-edit.model.tip"
              />
            }
            style={{ marginBottom: 16 }}
          >
            <Form.Item
              name="agent_kind"
              label="Agent 内核"
              tooltip={handbookBody(
                handbook,
                "console.business-edit.model.agent-kind",
              )}
              rules={[{ required: true, message: "请选择 agent 内核" }]}
              extra={
                isEdit &&
                watchedAgentKind !== undefined &&
                watchedAgentKind !== "" &&
                agents.length > 0 &&
                !agents.includes(watchedAgentKind) ? (
                  <span style={{ color: "#faad14" }}>
                    该 agent 内核已不在可选列表
                  </span>
                ) : undefined
              }
            >
              <Select
                aria-label="Agent 内核"
                options={agents.map((a) => ({ value: a, label: a }))}
              />
            </Form.Item>
            {/* 大模型配置（业务自定义 models.json 是唯一模型来源）：
                编辑页 = 完整配置区（在线验证-确认流程）；创建页 = 警告（业务创建后才能在编辑页配置） */}
            {isEdit && id !== undefined ? (
              <PiConfigSection businessId={id} />
            ) : (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 24 }}
                message="大模型：创建后配置"
                description="业务创建后才能配置大模型：创建后请在编辑页的大模型配置区完成 models.json 配置并在线验证。未配置的业务无法使用大模型推理（sdk.agent 调用将失败）；不使用大模型的纯程序业务可忽略。"
              />
            )}
          </Card>
        </div>

        <div id="sec-prompt">
          <Card
            title={
              <SectionHelp
                title="提示词配置"
                entries={handbook}
                tipId="console.business-edit.prompt.tip"
              />
            }
            style={{ marginBottom: 16 }}
          >
            <Form.Item
              name="prompt"
              label="提示词总纲"
              tooltip={handbookBody(
                handbook,
                "console.business-edit.prompt.tip",
              )}
              style={{ marginBottom: 0 }}
            >
              <Input.TextArea
                aria-label="提示词总纲"
                rows={6}
                placeholder="业务级提示词，拼在包/工具/skill 之前。写清业务目标与边界。"
              />
            </Form.Item>
          </Card>
        </div>

        <div id="sec-assets">
          <Card
            title={
              <SectionHelp
                title="资产配置"
                entries={handbook}
                tipId="console.business-edit.assets.tip"
                drawerId="console.business-edit.assets.detail"
              />
            }
            style={{ marginBottom: 16 }}
          >
            <Form.Item
              name="package_asset_id"
              label="包绑定"
              tooltip={handbookBody(
                handbook,
                "console.business-edit.assets.package-asset-id",
              )}
              rules={[
                { required: true, message: "必须绑定包资产，否则业务无法运行" },
              ]}
              extra={
                packages.length === 0 ? (
                  <span>
                    还没有可用的包资产。包是业务代码单位（恰好绑定一个），
                    <Link to="/assets">先去资产管理登记</Link>。
                  </span>
                ) : undefined
              }
            >
              <Select
                aria-label="包绑定"
                placeholder="选择包资产（我的包）"
                options={assetOptions(packages)}
                onChange={(assetId: string) => {
                  form.setFieldValue("entry_program", undefined);
                  setEntryPrograms([]);
                  void loadEntryPrograms(assetId);
                }}
              />
            </Form.Item>
            <Form.Item
              name="entry_program"
              label="入口程序"
              tooltip={handbookBody(
                handbook,
                "console.business-edit.assets.entry-program",
              )}
              rules={[{ required: true, message: "请选择入口程序" }]}
            >
              <Select
                aria-label="入口程序"
                placeholder="包清单 programs 的键"
                options={entryPrograms.map((p) => ({ value: p, label: p }))}
              />
            </Form.Item>
            <Form.Item
              name="tool_asset_ids"
              label="工具绑定"
              tooltip={handbookBody(
                handbook,
                "console.business-edit.assets.tool-asset-ids",
              )}
              extra={
                tools.length === 0 ? (
                  <span>
                    没有可绑定的工具资产（可选项）。工具是可共享的子程序，
                    sdk.run 按名调用；需要时
                    <Link to="/assets">去资产管理登记</Link>。
                  </span>
                ) : undefined
              }
            >
              <Select
                aria-label="工具绑定"
                mode="multiple"
                allowClear
                placeholder="选择工具资产（我的 + 共享的）"
                options={assetOptions(tools)}
              />
            </Form.Item>
            <Form.Item
              name="skill_asset_ids"
              label="Skill 绑定"
              tooltip={handbookBody(
                handbook,
                "console.business-edit.assets.skill-asset-ids",
              )}
              extra={
                skills.length === 0 ? (
                  <span>
                    没有可绑定的 skill 集合（可选项）。skill 是给大模型的能力，
                    sdk.agent 按名注入；需要时
                    <Link to="/assets">去资产管理登记</Link>。
                  </span>
                ) : undefined
              }
            >
              <Select
                aria-label="Skill 绑定"
                mode="multiple"
                allowClear
                placeholder="选择 skill 集合资产（我的 + 共享的）"
                options={assetOptions(skills)}
              />
            </Form.Item>
          </Card>
        </div>

        <div id="sec-entry">
          <Card
            title={
              <SectionHelp
                title="入口配置"
                entries={handbook}
                tipId="console.business-edit.entry.tip"
                drawerId="console.business-edit.entry.detail"
              />
            }
            style={{ marginBottom: 16 }}
          >
            <MatchEditor
              value={matches}
              onChange={(rows) => {
                setMatches(rows);
                scheduleDraftWrite();
              }}
              entryAdapters={entryAdapters}
              businesses={businesses}
            />
          </Card>
        </div>

        <div id="sec-exit">
          <Card
            title={
              <SectionHelp
                title="出口配置"
                entries={handbook}
                tipId="console.business-edit.exit.tip"
              />
            }
            style={{ marginBottom: 16 }}
          >
            {exitTools.map((tool) => {
              const checked = checkedExits[tool.kind] === true;
              const configText = exitConfigTexts[tool.kind] ?? "";
              const parsedConfig = parseExitConfigText(configText);
              return (
                <div key={tool.kind} style={{ marginBottom: 12 }}>
                  <Checkbox
                    checked={checked}
                    disabled={!tool.implemented}
                    onChange={(e) => {
                      setCheckedExits((prev) => ({
                        ...prev,
                        [tool.kind]: e.target.checked,
                      }));
                      scheduleDraftWrite();
                    }}
                  >
                    {tool.name}（{tool.kind}）
                    {!tool.implemented && (
                      <span style={{ color: "#999" }}>（未实现，占位）</span>
                    )}
                  </Checkbox>
                  {checked && (
                    <div style={{ marginLeft: 24, marginTop: 8 }}>
                      {!parsedConfig.ok && (
                        <Alert
                          type="error"
                          showIcon
                          style={{ marginBottom: 8 }}
                          message={`出口「${tool.name}」的配置不是合法 JSON object（请先在「JSON」视图修正）`}
                        />
                      )}
                      <Tabs
                        size="small"
                        aria-label={`出口 ${tool.kind} 配置视图`}
                        items={[
                          {
                            key: "form",
                            label: "表单",
                            disabled: !parsedConfig.ok,
                            children: (
                              <div
                                style={{
                                  display: "flex",
                                  flexDirection: "column",
                                  gap: 8,
                                }}
                              >
                                {tool.configSchema.map((field) => (
                                  <div key={field.key}>
                                    <div style={{ marginBottom: 4 }}>
                                      {field.required === true && (
                                        <span style={{ color: "#ff4d4f" }}>
                                          *{" "}
                                        </span>
                                      )}
                                      {field.label}
                                      <span
                                        style={{ color: "#999", fontSize: 12 }}
                                      >
                                        （{field.key}）
                                      </span>
                                    </div>
                                    <Input
                                      aria-label={`出口 ${tool.kind} ${field.key}`}
                                      placeholder={field.placeholder}
                                      disabled={!parsedConfig.ok}
                                      value={exitConfigFieldValue(
                                        configText,
                                        field.key,
                                      )}
                                      onChange={(e) =>
                                        setExitConfigValue(
                                          tool.kind,
                                          field.key,
                                          e.target.value,
                                        )
                                      }
                                    />
                                    {field.secret === true && (
                                      <div
                                        style={{ color: "#999", fontSize: 12 }}
                                      >
                                        {
                                          "建议填 {{key}} 占位，真值存安全变量（本业务环境配置的 secrets）"
                                        }
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ),
                          },
                          {
                            key: "json",
                            label: "JSON",
                            children: (
                              <Input.TextArea
                                aria-label={`出口 ${tool.kind} 配置 JSON`}
                                rows={4}
                                placeholder={exitConfigTemplate(tool)}
                                value={configText}
                                status={parsedConfig.ok ? "" : "error"}
                                onChange={(e) => {
                                  setExitConfigTexts((prev) => ({
                                    ...prev,
                                    [tool.kind]: e.target.value,
                                  }));
                                  scheduleDraftWrite();
                                }}
                              />
                            ),
                          },
                        ]}
                      />
                      {/* 该出口期望 sdk.return 返回的形状：内容较长，移入抽屉 */}
                      {tool.resultDoc != null && tool.resultDoc !== "" && (
                        <div style={{ marginTop: 8 }}>
                          <ResultDocButton
                            toolName={tool.name}
                            doc={tool.resultDoc}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        </div>

        {/* 环境配置：创建态 = 随建 Collapse（可选）；编辑态 = EnvEditor 卡片（ref.save 由主保存统一落库）。
            统一命名「环境配置」（原编辑态「业务 key-value」为实现视角叫法） */}
        <div id="sec-env">
          {!isEdit ? (
            <Collapse
              style={{ marginBottom: 16 }}
              defaultActiveKey={["env"]}
              items={[
                {
                  key: "env",
                  label: (
                    <SectionHelp
                      title="环境配置（可选，随业务一并创建）"
                      entries={handbook}
                      tipId="console.business-edit.env.tip"
                    />
                  ),
                  children: (
                    <CreateEnvEditor
                      vars={envVars}
                      secrets={envSecrets}
                      onVarsChange={(rows) => {
                        setEnvVars(rows);
                        scheduleDraftWrite();
                      }}
                      onSecretsChange={(rows) => {
                        setEnvSecrets(rows);
                        scheduleDraftWrite();
                      }}
                    />
                  ),
                },
              ]}
            />
          ) : (
            <Card
              title={
                <SectionHelp
                  title="环境配置"
                  entries={handbook}
                  tipId="console.business-edit.env.tip"
                />
              }
              style={{ marginBottom: 16 }}
            >
              {/* 行内草稿由主「保存」统一落库（ref.save()）；仍独立请求序列，不并入 PATCH body */}
              <EnvEditor
                ref={envEditorRef}
                scope="business"
                businessId={id}
                hideActions
              />
            </Card>
          )}
        </div>

        {/* 运行策略：行式布局（左名称+小字说明 / 右控件），继承可视化——
            留空 = 继承全局默认，小字直接显示当前继承到的值 */}
        <div id="sec-runtime">
          <Card
            title={
              <SectionHelp
                title="运行策略配置"
                entries={handbook}
                tipId="console.business-edit.runtime.tip"
              />
            }
            style={{ marginBottom: 16 }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                padding: "10px 0",
                borderBottom: "1px solid #f5f5f5",
              }}
            >
              <div style={{ flex: 1 }}>
                <div>失败传播</div>
                <div style={{ color: "#999", fontSize: 12, marginTop: 2 }}>
                  开启后，本业务失败也会派生事件（带失败状态）扇出给下游与出口；默认关闭下失败静默，下游需要感知失败做善后时才开启。
                </div>
              </div>
              <Form.Item name="on_failure" valuePropName="checked" noStyle>
                <Switch aria-label="失败传播" />
              </Form.Item>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                padding: "10px 0",
                borderBottom: "1px solid #f5f5f5",
              }}
            >
              <div style={{ flex: 1 }}>
                <div>run 超时覆盖（分钟）</div>
                <div style={{ color: "#999", fontSize: 12, marginTop: 2 }}>
                  {globalDefaults.task_timeout_minutes !== undefined
                    ? `留空 = 继承全局默认（当前 ${globalDefaults.task_timeout_minutes} 分钟，通用配置页可改）。`
                    : "留空 = 继承全局默认（通用配置页可改）。"}
                  过短 = 正常业务被强杀；过长 = 失控任务长期占用并发闸门。
                </div>
                {(formValues?.timeout_minutes ?? null) != null &&
                  (formValues.timeout_minutes as number) < 5 && (
                    <div
                      style={{ color: "#faad14", fontSize: 12, marginTop: 2 }}
                    >
                      小于 5 分钟的超时对多数 agent 任务偏紧，请确认是有意为之
                    </div>
                  )}
              </div>
              <Form.Item name="timeout_minutes" noStyle>
                <InputNumber
                  aria-label="超时覆盖"
                  min={1}
                  placeholder="继承全局"
                />
              </Form.Item>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                padding: "10px 0",
              }}
            >
              <div style={{ flex: 1 }}>
                <div>agent 调用配额覆盖</div>
                <div style={{ color: "#999", fontSize: 12, marginTop: 2 }}>
                  {globalDefaults.max_agent_calls !== undefined
                    ? `留空 = 继承全局默认（当前 ${globalDefaults.max_agent_calls} 次/单 run，通用配置页可改）。`
                    : "留空 = 继承全局默认（通用配置页可改）。"}
                  过低 = 正常流程被配额强杀；过高 = 失控循环烧钱。
                </div>
                {(formValues?.max_agent_calls ?? null) != null &&
                  (formValues.max_agent_calls as number) > 100 && (
                    <div
                      style={{ color: "#faad14", fontSize: 12, marginTop: 2 }}
                    >
                      超过 100 次的配额偏高，失控循环的成本风险请留意
                    </div>
                  )}
              </div>
              <Form.Item name="max_agent_calls" noStyle>
                <InputNumber
                  aria-label="配额覆盖"
                  min={1}
                  placeholder="继承全局"
                />
              </Form.Item>
            </div>
          </Card>
        </div>

        {/* 定时任务（仅编辑态且包清单有声明才显示）：只读清单 + 手动「立即执行」。
            声明归包清单 scheduled_tasks（平台登记期校验），本区不开放编辑 */}
        {isEdit && scheduledTasks.length > 0 && (
          <div id="sec-scheduled-tasks">
            <Card title="定时任务" style={{ marginBottom: 16 }}>
              <Table<TaskView>
                rowKey="name"
                size="small"
                pagination={false}
                dataSource={scheduledTasks}
                columns={[
                  { title: "名称", dataIndex: "name" },
                  { title: "程序", dataIndex: "program" },
                  {
                    title: "节奏",
                    render: (_, task) => `每 ${task.every_minutes} 分钟`,
                  },
                  {
                    title: "超时",
                    render: (_, task) =>
                      task.timeout_minutes !== undefined
                        ? `${task.timeout_minutes} 分钟`
                        : "继承业务/全局",
                  },
                  {
                    title: "最近状态",
                    render: (_, task) =>
                      task.last_run !== undefined ? (
                        <Tag
                          color={
                            RUN_STATUS_COLOR[
                              task.last_run.status as LifecycleStatus
                            ] ?? "default"
                          }
                        >
                          {task.last_run.status}
                        </Tag>
                      ) : (
                        "未运行"
                      ),
                  },
                  {
                    title: "最近运行时间",
                    render: (_, task) => task.last_run?.created_at ?? "—",
                  },
                  {
                    title: "操作",
                    render: (_, task) => (
                      <Button
                        size="small"
                        aria-label={`立即执行 ${task.name}`}
                        loading={runningTaskName === task.name}
                        onClick={() => void runTask(task.name)}
                      >
                        立即执行
                      </Button>
                    ),
                  },
                ]}
              />
            </Card>
          </div>
        )}
      </Form>

      {/* 编辑模式的全部资料/环境修改经统一更新队列生效（不展示队列状态，只给统一说明） */}
      {isEdit && <EffectivenessNote />}

      {/* 唯一保存按钮固定页面最底部 */}
      <Button
        type="primary"
        size="large"
        style={{ marginTop: 16 }}
        loading={submitting}
        onClick={() => void submit()}
      >
        {isEdit ? "保存" : "创建业务"}
      </Button>
    </div>
  );
}
