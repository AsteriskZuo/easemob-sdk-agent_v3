import { useCallback, useEffect, useMemo, useState } from "react";
import {
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Tooltip,
} from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import { useNavigate, useParams } from "react-router-dom";
import type {
  AssetManifest,
  AssetMeta,
  BusinessDetail,
  CreateBusinessBody,
  EnvListView,
  ExitToolMenuItem,
  MatchBody,
  PatchBusinessBody,
} from "@easemob/agent-console-api";
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

  // 初始加载：出口工具菜单 + 三类资产下拉数据源
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
  }, [reportError]);

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
          agent_kind: "pi",
          model: "qwen3.8max",
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
            rules={[
              { required: true, whitespace: true, message: "业务名称不能为空" },
            ]}
          >
            <Input aria-label="业务名称" placeholder="如：代码评审助手" />
          </Form.Item>
          <Form.Item
            name="agent_kind"
            label="Agent"
            rules={[{ required: true }]}
          >
            <Select
              aria-label="Agent"
              options={[{ value: "pi", label: "pi" }]}
            />
          </Form.Item>
          <Form.Item name="model" label="大模型" rules={[{ required: true }]}>
            <Select
              aria-label="大模型"
              options={[{ value: "qwen3.8max", label: "qwen3.8max" }]}
            />
          </Form.Item>
          <Form.Item name="prompt" label="提示词总纲">
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
              tip="包 = 业务流程程序（必填，否则业务无法运行）；工具/skill = 包声明依赖的实现。改了立即作用于后续 run。"
            />
          }
          style={{ marginBottom: 16 }}
        >
          <Form.Item
            name="package_asset_id"
            label="包绑定"
            rules={[
              { required: true, message: "必须绑定包资产，否则业务无法运行" },
            ]}
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
            rules={[{ required: true, message: "请选择入口程序" }]}
          >
            <Select
              aria-label="入口程序"
              placeholder="包清单 programs 的键"
              options={entryPrograms.map((p) => ({ value: p, label: p }))}
            />
          </Form.Item>
          <Form.Item name="tool_asset_ids" label="工具绑定">
            <Select
              aria-label="工具绑定"
              mode="multiple"
              allowClear
              placeholder="选择工具资产（我的 + 共享的）"
              options={assetOptions(tools)}
            />
          </Form.Item>
          <Form.Item name="skill_asset_ids" label="Skill 绑定">
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
              tip="决定什么事件触发本业务。配错 = 业务不触发或误触发。"
            />
          }
          style={{ marginBottom: 16 }}
        >
          <MatchEditor value={matches} onChange={setMatches} />
        </Card>

        <Card
          title={
            <SectionTitle
              title="出口（可选）"
              tip="业务结果投递到哪。机密项（如 token）写入业务层安全桶，不回显；配错 = 运行时投递失败。"
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
                              <span style={{ color: "#999", marginLeft: 8 }}>
                                （机密，存安全桶{" "}
                                {exitSecretKey(tool.kind, field.key)}）
                              </span>
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
              tip="超时/配额留空 = 用全局默认（见通用配置页）；失败传播开启后，本业务失败也会触发下游关注失败事件的匹配行。"
            />
          }
          style={{ marginBottom: 16 }}
        >
          <Form.Item name="on_failure" label="失败传播" valuePropName="checked">
            <Switch aria-label="失败传播" />
          </Form.Item>
          <Form.Item name="timeout_minutes" label="超时覆盖（分钟，可清空）">
            <InputNumber aria-label="超时覆盖" min={1} placeholder="全局默认" />
          </Form.Item>
          <Form.Item
            name="max_agent_calls"
            label="agent 调用配额覆盖（可清空）"
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
              tip="仅本业务生效的环境配置，独立于上方表单保存。安全桶存本业务的机密（如出口 token）。"
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
