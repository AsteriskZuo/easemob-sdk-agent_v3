import { useCallback, useEffect, useState } from "react";
import {
  App as AntdApp,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import type {
  AssetKind,
  AssetMeta,
  AssetObject,
  RegisterAssetBody,
} from "@asteriskzuo/agent-console-api";
import { apiFetch, ApiError } from "../api/client";
import { assetName } from "../asset-name";
import { useAuth } from "../auth/AuthContext";
import EffectivenessNote from "../components/EffectivenessNote";

type Scope = "mine" | "shared" | "all";

const KIND_TABS: Array<{ key: AssetKind; label: string }> = [
  { key: "package", label: "包" },
  { key: "tool", label: "工具" },
  { key: "skill", label: "Skill" },
];

/** 登记抽屉 subpath 提示：按 kind 区分（工具/Skill 建议叶子级登记，属约定，服务端不强制） */
const SUBPATH_HINT: Record<AssetKind, string> = {
  package: "资产根在仓库内的相对路径，缺省 = 仓库根",
  tool: "建议叶子级：tools/<工具名>，单个工具一个资产，便于按需共享",
  skill: "建议叶子级：skills/<技能名>，单个技能一个资产，便于按需共享",
};

/** 资产管理：三族 Tab + scope 筛选 + 登记/详情/上架下架/删除。
 *  下架 = enabled 开关（登记/绑定/缓存保留，重新上架恢复）；删除 = 物理移除。
 *  admin 不持有资产——登记入口对 admin 隐藏（API 侧也 403） */
export default function AssetsPage() {
  const { user } = useAuth();
  const { message } = AntdApp.useApp();
  const [kind, setKind] = useState<AssetKind>("package");
  const [scope, setScope] = useState<Scope>("mine");
  const [assets, setAssets] = useState<AssetMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [detail, setDetail] = useState<AssetObject | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [updateTarget, setUpdateTarget] = useState<AssetMeta | null>(null);
  const [updateRefValue, setUpdateRefValue] = useState("");
  const [updating, setUpdating] = useState(false);
  const [form] = Form.useForm<RegisterAssetBody>();
  const isPrivate = Form.useWatch("is_private", form) === true;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setAssets(
        await apiFetch<AssetMeta[]>(`/api/assets?kind=${kind}&scope=${scope}`),
      );
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : "加载资产失败");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, scope]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const register = async () => {
    let values: RegisterAssetBody;
    try {
      values = await form.validateFields();
    } catch {
      return; // 校验失败：antd 已在表单内报错，不提交
    }
    setSubmitting(true);
    try {
      const body: RegisterAssetBody = {
        kind,
        url: values.url,
        ref: values.ref,
        ...(values.subpath ? { subpath: values.subpath } : {}),
        ...(kind !== "package" && values.shared === true
          ? { shared: true }
          : {}),
        ...(values.is_private === true
          ? { is_private: true, credential_key: values.credential_key }
          : {}),
      };
      await apiFetch<AssetMeta>("/api/assets", { method: "POST", body });
      message.success("登记成功");
      setDrawerOpen(false);
      form.resetFields();
      await reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : "登记失败");
    } finally {
      setSubmitting(false);
    }
  };

  const showDetail = async (assetId: string) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      setDetail(await apiFetch<AssetObject>(`/api/assets/${assetId}`));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : "加载详情失败");
      setDetailLoading(false);
    }
  };

  /** 上架/下架开关（经统一更新队列生效）：只改 enabled 标记，登记、绑定与缓存均保留 */
  const setEnabled = async (assetId: string, enabled: boolean) => {
    try {
      await apiFetch<AssetMeta>(`/api/assets/${assetId}/status`, {
        method: "PUT",
        body: { enabled },
      });
      message.success(enabled ? "已上架" : "已下架");
      await reload();
    } catch (err) {
      message.error(
        err instanceof ApiError
          ? err.message
          : enabled
            ? "上架失败"
            : "下架失败",
      );
    }
  };

  /** 删除（物理删除：移除登记并清理物化缓存；有在役引用时服务端 409 拒绝） */
  const remove = async (assetId: string) => {
    try {
      await apiFetch<void>(`/api/assets/${assetId}`, { method: "DELETE" });
      message.success("已删除");
      await reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : "删除失败");
    }
  };

  const submitUpdate = async () => {
    if (updateTarget === null) return;
    const ref = updateRefValue.trim();
    if (ref.length === 0) {
      message.warning("请输入分支 / tag / commit");
      return;
    }
    setUpdating(true);
    try {
      await apiFetch<AssetMeta>(`/api/assets/${updateTarget.asset_id}`, {
        method: "PUT",
        body: { ref },
      });
      message.success("版本已更新并重新物化");
      setUpdateTarget(null);
      await reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : "更新失败");
    } finally {
      setUpdating(false);
    }
  };

  const canRegister = user?.role === "member";

  return (
    <div>
      <div style={{ marginBottom: 16, display: "flex", alignItems: "center" }}>
        <h2 style={{ margin: 0, flex: 1 }}>
          资产管理
          <Tooltip title="资产 = git 仓库里的包/工具/skill 集合。登记 = 记录仓库坐标；首次查看详情会物化（git 克隆，较慢）。下架 = 开关：绑定该资产的业务运行时将直接失败，重新上架后恢复，登记/绑定/缓存均保留。删除 = 物理移除登记与缓存（有在役引用会被拒绝）。工具/Skill 建议按单个目录登记（叶子级），共享时他人按个绑定。">
            <QuestionCircleOutlined style={{ marginLeft: 8, color: "#999" }} />
          </Tooltip>
        </h2>
        <Select
          aria-label="范围筛选"
          style={{ width: 140, marginRight: 8 }}
          value={scope}
          onChange={setScope}
          options={[
            { value: "mine", label: "我的" },
            { value: "shared", label: "共享的" },
            { value: "all", label: "全部" },
          ]}
        />
        {canRegister && (
          <Button type="primary" onClick={() => setDrawerOpen(true)}>
            登记资产
          </Button>
        )}
      </div>
      <Tabs
        activeKey={kind}
        onChange={(k) => setKind(k as AssetKind)}
        items={KIND_TABS.map((t) => ({ key: t.key, label: t.label }))}
      />
      <Table
        rowKey="asset_id"
        loading={loading}
        dataSource={assets}
        pagination={false}
        columns={[
          {
            title: "资产 ID",
            dataIndex: "asset_id",
            render: (id: string) => (
              <Typography.Text copyable={{ text: id }}>
                {id.slice(0, 12)}…
              </Typography.Text>
            ),
          },
          {
            title: "名称",
            key: "name",
            render: (_, row: AssetMeta) => assetName(row) ?? "—",
          },
          { title: "属主", dataIndex: "owner_id" },
          {
            title: "状态",
            key: "enabled",
            render: (_, row: AssetMeta) =>
              row.enabled ? (
                <Tag color="green">已上架</Tag>
              ) : (
                <Tag color="red">已下架</Tag>
              ),
          },
          {
            title: "标记",
            key: "flags",
            render: (_, row: AssetMeta) => (
              <>
                {row.shared && <Tag color="blue">共享</Tag>}
                {row.is_private && <Tag color="orange">私有</Tag>}
              </>
            ),
          },
          { title: "登记时间", dataIndex: "created_at" },
          {
            title: "操作",
            key: "actions",
            render: (_: unknown, row: AssetMeta) => (
              <>
                <Button
                  size="small"
                  type="link"
                  onClick={() => void showDetail(row.asset_id)}
                >
                  详情
                </Button>
                {/* 更新/上下架/删除仅属主本人可见（API 侧也强制）；共享资产禁止更新版本 */}
                {user !== null && row.owner_id === user.user_id && (
                  <>
                    {row.shared ? (
                      <Tooltip title="共享资产不可更新版本：可能被他人业务引用，静默换版本会让别人莫名出问题。如需新版本请以不同 url/subpath 重新登记新资产。">
                        <Button size="small" type="link" disabled>
                          更新
                        </Button>
                      </Tooltip>
                    ) : (
                      <Button
                        size="small"
                        type="link"
                        onClick={() => {
                          setUpdateTarget(row);
                          setUpdateRefValue("");
                        }}
                      >
                        更新
                      </Button>
                    )}
                    {row.enabled ? (
                      <Popconfirm
                        title="确认下架？下架后绑定该资产的业务运行时将直接失败（shared 资产可能包含其他用户的业务），重新上架后恢复；登记、绑定与缓存均保留。"
                        okText="下架"
                        cancelText="取消"
                        onConfirm={() => void setEnabled(row.asset_id, false)}
                      >
                        <Button size="small" type="link">
                          下架
                        </Button>
                      </Popconfirm>
                    ) : (
                      <Button
                        size="small"
                        type="link"
                        onClick={() => void setEnabled(row.asset_id, true)}
                      >
                        上架
                      </Button>
                    )}
                    <Popconfirm
                      title="确认删除？删除将移除登记并清理物化缓存，绑定该资产的业务运行时将失败（有在役引用时会被拒绝）。只想暂时停用请用「下架」。"
                      okText="删除"
                      cancelText="取消"
                      onConfirm={() => void remove(row.asset_id)}
                    >
                      <Button size="small" type="link" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  </>
                )}
              </>
            ),
          },
        ]}
      />

      {/* 登记/更新/上下架/删除均经统一更新队列生效（不展示队列状态，只给统一说明） */}
      <EffectivenessNote />

      <Drawer
        title={`登记${KIND_TABS.find((t) => t.key === kind)?.label ?? ""}资产`}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        width={480}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="url"
            label="仓库地址"
            rules={[
              { required: true, whitespace: true, message: "请输入仓库地址" },
            ]}
          >
            <Input
              aria-label="仓库地址"
              placeholder="git 仓库地址（本地路径亦可）"
            />
          </Form.Item>
          <Form.Item
            name="ref"
            label="分支 / tag / commit"
            rules={[
              { required: true, whitespace: true, message: "请输入 ref" },
            ]}
            extra="登记时解析成 commit 存定。"
          >
            <Input aria-label="ref" placeholder="如 main" />
          </Form.Item>
          <Form.Item
            name="subpath"
            label="子路径（可选）"
            extra={SUBPATH_HINT[kind]}
          >
            <Input aria-label="子路径" />
          </Form.Item>
          {kind !== "package" && (
            <Form.Item
              name="shared"
              label="共享（全员可见可绑定）"
              valuePropName="checked"
            >
              <Switch aria-label="共享" />
            </Form.Item>
          )}
          <Form.Item name="is_private" label="私有仓库" valuePropName="checked">
            <Switch aria-label="私有仓库" />
          </Form.Item>
          {isPrivate && (
            <Form.Item
              name="credential_key"
              label={
                <span>
                  凭据 key
                  <Tooltip title="凭据值需先在通用配置安全桶登记同名 key；此处只填 key 名，不填值。">
                    <QuestionCircleOutlined
                      style={{ marginLeft: 6, color: "#999" }}
                    />
                  </Tooltip>
                </span>
              }
              rules={[{ required: true, message: "私有仓库必须填凭据 key" }]}
            >
              <Input
                aria-label="凭据 key"
                placeholder="通用配置安全桶中的键名"
              />
            </Form.Item>
          )}
          <Button
            type="primary"
            block
            loading={submitting}
            onClick={() => void register()}
          >
            登记
          </Button>
        </Form>
      </Drawer>

      <Modal
        title="更新资产版本"
        open={updateTarget !== null}
        onCancel={() => setUpdateTarget(null)}
        onOk={() => void submitUpdate()}
        okText="更新"
        cancelText="取消"
        confirmLoading={updating}
        destroyOnHidden
      >
        <p style={{ color: "#666" }}>
          输入新的分支 / tag / commit，平台解析成 commit 后重新物化（git
          克隆+构建，可能较慢）。资产 ID 不变，绑定它的业务无需改动。
        </p>
        <Input
          aria-label="新版本 ref"
          placeholder="如 main 或完整 commit id"
          value={updateRefValue}
          onChange={(e) => setUpdateRefValue(e.target.value)}
          onPressEnter={() => void submitUpdate()}
        />
      </Modal>

      <Modal
        title="资产详情"
        open={detailLoading || detail !== null}
        onCancel={() => {
          setDetail(null);
          setDetailLoading(false);
        }}
        footer={null}
        width={640}
      >
        {detail === null ? (
          <p>加载中…首次查看可能触发 git 克隆，较慢。</p>
        ) : (
          <>
            <Descriptions
              bordered
              size="small"
              column={1}
              style={{ marginBottom: 16 }}
            >
              <Descriptions.Item label="资产 ID">
                {detail.meta.asset_id}
              </Descriptions.Item>
              <Descriptions.Item label="类别">
                {detail.meta.kind}
              </Descriptions.Item>
              <Descriptions.Item label="属主">
                {detail.meta.owner_id}
              </Descriptions.Item>
              <Descriptions.Item label="登记时间">
                {detail.meta.created_at}
              </Descriptions.Item>
            </Descriptions>
            <h4>清单（manifest）</h4>
            <pre style={{ background: "#f5f5f5", padding: 12, fontSize: 12 }}>
              {JSON.stringify(detail.manifest, null, 2)}
            </pre>
          </>
        )}
      </Modal>
    </div>
  );
}
