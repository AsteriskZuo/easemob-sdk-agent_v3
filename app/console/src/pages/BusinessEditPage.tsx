import { useCallback, useEffect, useMemo, useState } from "react";
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Tag,
  Tooltip,
} from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import { Link, useNavigate, useParams } from "react-router-dom";
import type {
  AssetManifest,
  AssetMeta,
  BusinessDetail,
  BusinessProfile,
  CreateBusinessBody,
  EffectiveConfigView,
  EntryAdapterView,
  EnvListView,
  ExitToolMenuItem,
  MatchBody,
  PatchBusinessBody,
} from "@asterisk/agent-console-api";
import { apiFetch, ApiError } from "../api/client";
import EnvEditor from "../components/EnvEditor";
import MatchEditor, { toMatchBody } from "../components/MatchEditor";
import type { MatchRow } from "../components/MatchEditor";

/** 表单字段（antd Form 承载的部分；匹配行与出口配置走独立 state） */
interface BusinessFormValues {
  business_name: string;
  package_asset_id: string;
  entry_program: string;
  tool_asset_ids?: string[];
  skill_asset_ids?: string[];
  agent_kind: string;
  model: string;
  prompt?: string;
  on_failure: boolean;
  timeout_minutes?: number | null;
  max_agent_calls?: number | null;
}

/** 表单区块标题 + 叹号提示（是什么/何时用/配错的后果） */
function SectionTitle({ title, tip }: { title: string; tip: string }) {
  return (
    <span>
      {title}
      <Tooltip title={tip}>
        <QuestionCircleOutlined style={{ marginLeft: 8, color: "#999" }} />
      </Tooltip>
    </span>
  );
}

/** 出口 secret 配置项的安全桶键（硬契约：exit.{kind}.{field.key}，与 T12 exit-driver 对齐） */
function exitSecretKey(kind: string, fieldKey: string): string {
  return `exit.${kind}.${fieldKey}`;
}

/** 业务创建/编辑同体页（/businesses/new 与 /businesses/:id 共用）。
 *  主保存按钮只管 registry 侧字段 + 匹配行 diff + 出口 secret 覆盖；
 *  业务 key-value 由 EnvEditor 独立保存（避免混合提交的部分失败语义） */
export default function BusinessEditPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = id !== undefined;
  const navigate = useNavigate();
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<BusinessFormValues>();

  const [loading, setLoading] = useState(isEdit);
  const [submitting, setSubmitting] = useState(false);
  const [matches, setMatches] = useState<MatchRow[]>([
    { source: "manual", event_type: "", entry_config_text: "" },
  ]);
  // 编辑态原始匹配行（保存时做增删 diff 的基准；key = `${source}\n${event_type}`）
  const [originalMatches, setOriginalMatches] = useState<MatchRow[]>([]);
  const [exitTools, setExitTools] = useState<ExitToolMenuItem[]>([]);
  const [checkedExits, setCheckedExits] = useState<Record<string, boolean>>({});
  const [exitValues, setExitValues] = useState<
    Record<string, Record<string, string>>
  >({});
  const [secretKeys, setSecretKeys] = useState<string[]>([]);
  const [packages, setPackages] = useState<AssetMeta[]>([]);
  const [tools, setTools] = useState<AssetMeta[]>([]);
  const [skills, setSkills] = useState<AssetMeta[]>([]);
  const [entryPrograms, setEntryPrograms] = useState<string[]>([]);
  // 可选集合由 server 解析 models.json 经 /api/config 提供——平台与 console 均不内置模型名
  const [models, setModels] = useState<string[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  // 入口适配器自描述（/api/config 的 entry_adapters）：MatchEditor 事件文档与 entry_config 表单数据源
  const [entryAdapters, setEntryAdapters] = useState<EntryAdapterView[]>([]);
  // 现有业务列表：source=internal 的「上游业务」下拉数据源
  const [businesses, setBusinesses] = useState<BusinessProfile[]>([]);
  // 编辑态失效侦测：profile 原值不在可选集合（models.json 后来改了）时保留显示并标黄
  const watchedModel = Form.useWatch("model", form);
  const watchedAgentKind = Form.useWatch("agent_kind", form);

  const reportError = useCallback(
    (err: unknown, fallback: string) => {
      message.error(err instanceof ApiError ? err.message : fallback);
    },
    [message],
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

  // 初始加载：出口工具菜单 + 三类资产下拉数据源 + 可选模型/内核（models.json 驱动）
  useEffect(() => {
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
        setModels(config.models);
        setAgents(config.agents);
        setEntryAdapters(config.entry_adapters);
        // 创建模式 agent 默认选中第一个可选项（模型无部署无关的合理默认，必须用户显式选）
        if (!isEdit && config.agents.length > 0) {
          if (form.getFieldValue("agent_kind") === undefined) {
            form.setFieldValue("agent_kind", config.agents[0]);
          }
        }
      })
      .catch((err: unknown) => reportError(err, "加载可选模型列表失败"));
    // 现有业务列表：internal 入口引导的「上游业务」下拉
    apiFetch<BusinessProfile[]>("/api/businesses")
      .then(setBusinesses)
      .catch((err: unknown) => reportError(err, "加载业务列表失败"));
  }, [reportError, isEdit, form]);

  // 编辑态：回填详情 + 安全桶键名
  useEffect(() => {
    if (!isEdit) return;
    setLoading(true);
    void (async () => {
      try {
        const detail = await apiFetch<BusinessDetail>(`/api/businesses/${id}`);
        const envView = await apiFetch<EnvListView>(
          `/api/env/businesses/${id}`,
        );
        const profile = detail.profile;
        form.setFieldsValue({
          business_name: profile.business_name,
          package_asset_id: profile.package_asset_id,
          entry_program: profile.entry_program,
          tool_asset_ids: profile.tool_asset_ids,
          skill_asset_ids: profile.skill_asset_ids,
          agent_kind: profile.agent_kind,
          model: profile.model,
          prompt: profile.prompt,
          on_failure: profile.on_failure,
          timeout_minutes: profile.timeout_minutes ?? null,
          max_agent_calls: profile.max_agent_calls ?? null,
        });
        const rows: MatchRow[] = detail.matches.map((m) => ({
          source: m.source,
          event_type: m.event_type,
          entry_config_text:
            m.entry_config !== undefined ? JSON.stringify(m.entry_config) : "",
        }));
        if (rows.length > 0) {
          setMatches(rows);
          setOriginalMatches(rows);
        }
        // 出口回填：非机密项原样回填；secret 项留空（占位「已配置」，填新值才覆盖）
        const checked: Record<string, boolean> = {};
        const values: Record<string, Record<string, string>> = {};
        for (const binding of detail.exit_bindings) {
          checked[binding.tool] = true;
          values[binding.tool] = { ...binding.config };
        }
        setCheckedExits(checked);
        setExitValues(values);
        setSecretKeys(envView.secret_keys);
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

  /** 出口表单值更新 */
  const setExitValue = (kind: string, fieldKey: string, value: string) => {
    setExitValues((prev) => ({
      ...prev,
      [kind]: { ...prev[kind], [fieldKey]: value },
    }));
  };

  /** 出口分流：secret 项 → 待写安全桶清单；非 secret 项 → ExitBinding.config */
  const splitExitConfig = (): {
    bindings: Array<{ tool: string; config: Record<string, string> }>;
    secrets: Array<{ key: string; value: string }>;
    problems: string[];
  } => {
    const bindings: Array<{ tool: string; config: Record<string, string> }> =
      [];
    const secrets: Array<{ key: string; value: string }> = [];
    const problems: string[] = [];
    for (const tool of exitTools) {
      if (checkedExits[tool.kind] !== true) continue;
      const config: Record<string, string> = {};
      for (const field of tool.configSchema) {
        const value = (exitValues[tool.kind]?.[field.key] ?? "").trim();
        if (field.secret === true) {
          if (value !== "") {
            secrets.push({ key: exitSecretKey(tool.kind, field.key), value });
          } else if (
            field.required === true &&
            !secretKeys.includes(exitSecretKey(tool.kind, field.key))
          ) {
            problems.push(
              `出口「${tool.name}」的必填机密项「${field.label}」未配置`,
            );
          }
          continue; // secret 项不进 ExitBinding.config
        }
        if (value !== "") {
          config[field.key] = value;
        } else if (field.required === true) {
          problems.push(`出口「${tool.name}」的必填项「${field.label}」未填写`);
        }
      }
      bindings.push({ tool: tool.kind, config });
    }
    return { bindings, secrets, problems };
  };

  /** 写出口 secret 项到业务层安全桶（依次 PUT） */
  const writeExitSecrets = async (
    businessId: string,
    secrets: Array<{ key: string; value: string }>,
  ) => {
    for (const secret of secrets) {
      await apiFetch<void>(`/api/env/businesses/${businessId}`, {
        method: "PUT",
        body: { bucket: "secrets", key: secret.key, value: secret.value },
      });
    }
  };

  const submit = async () => {
    let values: BusinessFormValues;
    try {
      values = await form.validateFields();
    } catch {
      return; // 表单内已报错
    }
    // 匹配行校验：全部行 JSON 合法；首行 source/event_type 非空
    const matchBodies = matches.map(toMatchBody);
    if (matchBodies.some((b) => b === null)) {
      message.error("匹配行的入口配置不是合法 JSON object，请修正后再提交");
      return;
    }
    // 上面已拦截 null（非法 JSON），此处收窄
    const validMatchBodies = matchBodies as MatchBody[];
    const first = matches[0];
    if (first.event_type.trim() === "") {
      message.error("首个匹配行的事件类型不能为空");
      return;
    }
    const { bindings, secrets, problems } = splitExitConfig();
    if (problems.length > 0) {
      message.error(problems[0]);
      return;
    }

    setSubmitting(true);
    try {
      if (!isEdit) {
        // 创建：POST → 拿 business_id → 追加匹配行/写出口 secret → 跳编辑页
        const [firstBody, ...restBodies] = validMatchBodies;
        const body: CreateBusinessBody = {
          business_name: values.business_name,
          source: firstBody.source,
          event_type: firstBody.event_type,
          ...(firstBody.entry_config !== undefined
            ? { entry_config: firstBody.entry_config }
            : {}),
          on_failure: values.on_failure,
          prompt: values.prompt ?? "",
          model: values.model,
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
        await writeExitSecrets(created.business_id, secrets);
        message.success("业务已创建");
        navigate(`/businesses/${created.business_id}`, { replace: true });
        return;
      }

      // 编辑：PATCH 资料字段（超时/配额清除 = null）+ 匹配行增删 diff + 出口 secret 覆盖
      const patch: PatchBusinessBody = {
        business_name: values.business_name,
        on_failure: values.on_failure,
        prompt: values.prompt ?? "",
        model: values.model,
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
      await writeExitSecrets(id, secrets);
      message.success("已保存");
      navigate("/businesses");
    } catch (err) {
      reportError(err, "保存失败");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ maxWidth: 860 }}>
      <h2>{isEdit ? "编辑业务" : "创建业务"}</h2>
      <Form
        form={form}
        layout="vertical"
        disabled={loading}
        initialValues={{
          on_failure: false,
        }}
      >
        <Card
          title={
            <SectionTitle
              title="基本信息"
              tip="业务的身份与执行内核。名称仅用于展示，不参与事件匹配。"
            />
          }
          style={{ marginBottom: 16 }}
        >
          <Form.Item
            name="business_name"
            label="业务名称"
            tooltip="是什么：业务的展示名。何时用：创建时命名，之后可改。配错后果：无执行影响，但重名会让运维分不清业务。"
            rules={[
              { required: true, whitespace: true, message: "业务名称不能为空" },
            ]}
          >
            <Input aria-label="业务名称" placeholder="如：代码评审助手" />
          </Form.Item>
          <Form.Item
            name="agent_kind"
            label="Agent"
            tooltip="是什么：执行大模型调用的内核程序（当前仅 pi）。何时用：一般保持默认。配错后果：不在可选集合的值保存时会被服务端拒绝。"
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
              aria-label="Agent"
              options={agents.map((a) => ({ value: a, label: a }))}
            />
          </Form.Item>
          <Form.Item
            name="model"
            label="大模型"
            tooltip="是什么：本业务大模型调用使用的模型，可选项来自服务端 models.json（provider/id 形式）。何时用：创建时必选，按业务质量与成本需要选择。配错后果：不在可选列表时保存被拒绝；运行期模型失效 = agent 调用失败。"
            rules={[{ required: true, message: "请选择模型" }]}
            extra={
              isEdit &&
              watchedModel !== undefined &&
              watchedModel !== "" &&
              models.length > 0 &&
              !models.includes(watchedModel) ? (
                <span style={{ color: "#faad14" }}>
                  该模型已不在可选列表（models.json 已变更）
                </span>
              ) : undefined
            }
          >
            <Select
              aria-label="大模型"
              placeholder="请选择模型"
              options={models.map((m) => ({ value: m, label: m }))}
            />
          </Form.Item>
          <Form.Item
            name="prompt"
            label="提示词总纲"
            tooltip="是什么：每次 agent 调用自动注入的业务总纲，说明业务规则、边界与不可做。何时用：业务需要稳定的行为约束时必写。配错后果：总纲缺失或过宽，模型输出质量与边界不可控。"
          >
            <Input.TextArea
              aria-label="提示词总纲"
              rows={6}
              placeholder="业务级提示词，拼在包/工具/skill 之前。写清业务目标与边界。"
            />
          </Form.Item>
        </Card>

        <Card
          title={
            <SectionTitle
              title="资产绑定"
              tip="是什么：业务要用的代码资产组合。何时用：创建业务时配置，改了立即作用于后续 run。配错后果：缺绑/名冲突保存时被服务端拒绝（消息会列出全部问题）。"
            />
          }
          style={{ marginBottom: 16 }}
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="包 / 工具 / skill 的关系"
            description="包 = 业务代码单位，提供流程程序入口（平台每次执行 spawn 它）与包内程序；工具 = 可共享的子程序，包代码用 sdk.run('程序名') 调用；skill = 给大模型的能力集合，sdk.agent 按名注入。工具与 skill 可绑多个（自己的 + 他人共享的），名冲突会被拒绝。"
          />
          <Form.Item
            name="package_asset_id"
            label="包绑定"
            tooltip="是什么：业务代码单位（恰好一个），提供流程程序入口与包内程序。何时用：创建业务必选。配错后果：不绑定包业务无法运行；绑错包 = 执行错误的流程。"
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
            tooltip="是什么：包清单 programs 中作为流程入口的程序名，平台每次执行 spawn 它。何时用：选定包后必选。配错后果：选错入口 = 执行了错误的程序。"
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
            tooltip="是什么：可共享的子程序资产，包代码用 sdk.run('程序名') 按名调用。何时用：包清单 requires.tools 声明了外部工具时必须绑定对应资产。配错后果：缺绑/程序名冲突保存时被拒绝；运行期按名找不到程序则 run 失败。"
            extra={
              tools.length === 0 ? (
                <span>
                  没有可绑定的工具资产（可选项）。工具是可共享的子程序， sdk.run
                  按名调用；需要时<Link to="/assets">去资产管理登记</Link>。
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
            tooltip="是什么：给大模型的能力集合，sdk.agent 按名注入（白名单校验）。何时用：包代码调 sdk.agent 引用 skill 时。配错后果：缺绑时 agent 调用被白名单拦截而失败。"
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

        <Card
          title={
            <SectionTitle
              title="入口（匹配行）"
              tip="是什么：决定什么事件触发本业务。三种入口：外部事件 = 入口适配器推送（如 webhook）；内部队列事件 = 关注上游业务的产出类型（业务id.产出类型）；定时 = 周期/绝对时间触发。何时用：每个业务至少一条匹配行。配错后果：事件类型写错 = 业务永远不触发；关注错上游 = 误触发。"
            />
          }
          style={{ marginBottom: 16 }}
        >
          <MatchEditor
            value={matches}
            onChange={setMatches}
            entryAdapters={entryAdapters}
            businesses={businesses}
          />
        </Card>

        <Card
          title={
            <SectionTitle
              title="出口（可选）"
              tip="是什么：业务结果的投递目的地（企微/邮件/webhook 等），投递不过大模型。何时用：结果需要通知人或系统时勾选并按 schema 填配置。配错后果：地址/账号填错 = 运行时投递失败进死信；机密项没配进安全桶 = 必填校验拦截或投递失败。"
            />
          }
          style={{ marginBottom: 16 }}
        >
          {exitTools.map((tool) => {
            const checked = checkedExits[tool.kind] === true;
            return (
              <div key={tool.kind} style={{ marginBottom: 12 }}>
                <Checkbox
                  checked={checked}
                  disabled={!tool.implemented}
                  onChange={(e) =>
                    setCheckedExits((prev) => ({
                      ...prev,
                      [tool.kind]: e.target.checked,
                    }))
                  }
                >
                  {tool.name}（{tool.kind}）
                  {!tool.implemented && (
                    <span style={{ color: "#999" }}>（未实现，占位）</span>
                  )}
                </Checkbox>
                {checked && (
                  <div
                    style={{
                      marginLeft: 24,
                      marginTop: 8,
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    {tool.configSchema.map((field) => {
                      const isSecret = field.secret === true;
                      const configured =
                        isSecret &&
                        secretKeys.includes(
                          exitSecretKey(tool.kind, field.key),
                        );
                      const placeholder = configured
                        ? "已配置（留空 = 不改动，填新值 = 覆盖）"
                        : field.placeholder;
                      return (
                        <div key={field.key}>
                          <div style={{ marginBottom: 4 }}>
                            {field.required === true && (
                              <span style={{ color: "#ff4d4f" }}>* </span>
                            )}
                            {field.label}
                            {isSecret && (
                              <>
                                <Tag
                                  color={configured ? "success" : "warning"}
                                  style={{ marginLeft: 8 }}
                                >
                                  {configured ? "已配置" : "未配置"}
                                </Tag>
                                <div style={{ color: "#999", fontSize: 12 }}>
                                  机密项，值存业务安全桶，键名：
                                  {exitSecretKey(tool.kind, field.key)}
                                  {isEdit
                                    ? "（也可在下方「业务 key-value」安全桶维护）"
                                    : "（此处填写将在创建后写入安全桶）"}
                                </div>
                              </>
                            )}
                          </div>
                          {isSecret ? (
                            <Input.Password
                              aria-label={`出口 ${tool.kind} ${field.key}`}
                              placeholder={placeholder}
                              value={exitValues[tool.kind]?.[field.key] ?? ""}
                              onChange={(e) =>
                                setExitValue(
                                  tool.kind,
                                  field.key,
                                  e.target.value,
                                )
                              }
                            />
                          ) : (
                            <Input
                              aria-label={`出口 ${tool.kind} ${field.key}`}
                              placeholder={placeholder}
                              value={exitValues[tool.kind]?.[field.key] ?? ""}
                              onChange={(e) =>
                                setExitValue(
                                  tool.kind,
                                  field.key,
                                  e.target.value,
                                )
                              }
                            />
                          )}
                        </div>
                      );
                    })}
                    {/* 该出口期望 sdk.return 返回的形状（markdown 原文展示，不引渲染器依赖） */}
                    {tool.resultDoc != null && tool.resultDoc !== "" && (
                      <div>
                        <div style={{ color: "#666", marginBottom: 4 }}>
                          该出口期望 sdk.return 返回的形状：
                        </div>
                        <pre
                          style={{
                            margin: 0,
                            padding: 12,
                            background: "#fafafa",
                            border: "1px solid #f0f0f0",
                            borderRadius: 6,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                            fontSize: 12,
                            maxHeight: 320,
                            overflow: "auto",
                          }}
                        >
                          {tool.resultDoc}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </Card>

        <Card
          title={
            <SectionTitle
              title="运行策略"
              tip="超时/配额留空 = 用全局默认（见通用配置页），业务级覆盖优先。"
            />
          }
          style={{ marginBottom: 16 }}
        >
          <Form.Item
            name="on_failure"
            label="失败传播"
            tooltip="是什么：开启后，本业务失败也会派生事件（带失败状态）扇出给下游与出口。何时用：下游需要感知失败做善后时。配错后果：默认关闭下失败静默，下游以为没发生；误开会让下游收到大量失败事件。"
            valuePropName="checked"
          >
            <Switch aria-label="失败传播" />
          </Form.Item>
          <Form.Item
            name="timeout_minutes"
            label="超时覆盖（分钟，可清空）"
            tooltip="是什么：本业务 run 的 wall-clock 超时（分钟），覆盖全局默认。何时用：业务明显长于/短于全局默认时。配错后果：过短 = 正常业务被强杀；过长 = 失控任务长期占用并发闸门。"
          >
            <InputNumber aria-label="超时覆盖" min={1} placeholder="全局默认" />
          </Form.Item>
          <Form.Item
            name="max_agent_calls"
            label="agent 调用配额覆盖（可清空）"
            tooltip="是什么：本业务单 run 的 agent 调用次数上限，覆盖全局默认。何时用：多轮/多阶段业务需要更多调用时。配错后果：过低 = 正常流程被配额强杀；过高 = 失控循环烧钱。"
          >
            <InputNumber aria-label="配额覆盖" min={1} placeholder="全局默认" />
          </Form.Item>
        </Card>

        <Button
          type="primary"
          size="large"
          loading={submitting}
          onClick={() => void submit()}
        >
          {isEdit ? "保存" : "创建业务"}
        </Button>
      </Form>

      {isEdit && (
        <Card
          title={
            <SectionTitle
              title="业务 key-value"
              tip="是什么：按业务注入的 key-value 配置——普通桶明文回显，安全桶只写不读（掩码）。何时用：包代码 sdk.config()/sdk.secret() 要读的参数与凭据（含出口机密项）。配错后果：键名写错 = 业务代码取不到值而失败；机密放普通桶 = 明文泄漏。"
            />
          }
          style={{ marginTop: 16 }}
        >
          {/* 独立保存：EnvEditor 自管理 PUT/DELETE，不并入主表单提交 */}
          <EnvEditor scope="business" businessId={id} />
        </Card>
      )}
    </div>
  );
}
