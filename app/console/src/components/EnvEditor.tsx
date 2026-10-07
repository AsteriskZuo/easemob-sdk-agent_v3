import { useCallback, useEffect, useState } from "react";
import {
  App as AntdApp,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Table,
  Tag,
  Tooltip,
} from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import type { EnvListView } from "@easemob/agent-console-api";
import { apiFetch, ApiError } from "../api/client";

export interface EnvEditorProps {
  /** 通用层（global）或业务层（business） */
  scope: "global" | "business";
  /** scope=business 时必填（业务 id） */
  businessId?: string;
  /** true = 只读（如 member 看通用层）：隐藏全部编辑入口 */
  readOnly?: boolean;
}

/** 两桶 key-value 编辑器：vars 表格增删改；secrets 只写（键名列表 + 新增 + 删除）。
 *  自管理读写（每个操作独立 PUT/DELETE），不并入外层表单提交——
 *  避免一次提交混合多资源的部分失败语义（spec 决策点 7） */
export default function EnvEditor({
  scope,
  businessId,
  readOnly,
}: EnvEditorProps) {
  const { message } = AntdApp.useApp();
  const [view, setView] = useState<EnvListView>({ vars: {}, secret_keys: [] });
  const [loading, setLoading] = useState(true);
  // vars 编辑弹窗：null=关闭；{key?} key 缺省 = 新增，有值 = 编辑（key 不可改）
  const [varModal, setVarModal] = useState<{ key?: string } | null>(null);
  const [secretModalOpen, setSecretModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [varForm] = Form.useForm<{ key: string; value: string }>();
  const [secretForm] = Form.useForm<{ key: string; value: string }>();

  const basePath =
    scope === "global"
      ? "/api/env/global"
      : `/api/env/businesses/${businessId}`;

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setView(await apiFetch<EnvListView>(basePath));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : "加载环境配置失败");
    } finally {
      setLoading(false);
    }
    // basePath 由 scope/businessId 派生；message 实例稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const reportError = (err: unknown, fallback: string) => {
    message.error(err instanceof ApiError ? err.message : fallback);
  };

  const saveVar = async () => {
    let values: { key: string; value: string };
    try {
      values = await varForm.validateFields();
    } catch {
      return; // 校验失败：antd 已在表单内报错
    }
    setSubmitting(true);
    try {
      await apiFetch<void>(basePath, {
        method: "PUT",
        body: { bucket: "vars", key: values.key, value: values.value },
      });
      message.success("已保存");
      setVarModal(null);
      await reload();
    } catch (err) {
      reportError(err, "保存失败");
    } finally {
      setSubmitting(false);
    }
  };

  const removeVar = async (key: string) => {
    try {
      await apiFetch<void>(basePath, {
        method: "DELETE",
        body: { bucket: "vars", key },
      });
      message.success("已删除");
      await reload();
    } catch (err) {
      reportError(err, "删除失败");
    }
  };

  const saveSecret = async () => {
    let values: { key: string; value: string };
    try {
      values = await secretForm.validateFields();
    } catch {
      return; // 校验失败：antd 已在表单内报错
    }
    setSubmitting(true);
    try {
      await apiFetch<void>(basePath, {
        method: "PUT",
        body: { bucket: "secrets", key: values.key, value: values.value },
      });
      message.success("已写入安全桶");
      setSecretModalOpen(false);
      await reload();
    } catch (err) {
      reportError(err, "写入失败");
    } finally {
      setSubmitting(false);
    }
  };

  const removeSecret = async (key: string) => {
    try {
      await apiFetch<void>(basePath, {
        method: "DELETE",
        body: { bucket: "secrets", key },
      });
      message.success("已删除");
      await reload();
    } catch (err) {
      reportError(err, "删除失败");
    }
  };

  const varRows = Object.entries(view.vars).map(([key, value]) => ({
    key,
    value,
  }));

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <span style={{ fontWeight: 600 }}>普通配置（vars）</span>
        <Tooltip title="明文键值对，业务运行时注入为环境变量。改了立即生效于后续 run；配错键名业务会取不到值。">
          <QuestionCircleOutlined style={{ marginLeft: 6, color: "#999" }} />
        </Tooltip>
        {!readOnly && (
          <Button
            size="small"
            style={{ marginLeft: 12 }}
            onClick={() => {
              varForm.resetFields();
              setVarModal({});
            }}
          >
            新增
          </Button>
        )}
      </div>
      <Table
        rowKey="key"
        size="small"
        loading={loading}
        dataSource={varRows}
        pagination={false}
        columns={[
          { title: "键", dataIndex: "key" },
          { title: "值", dataIndex: "value" },
          ...(readOnly
            ? []
            : [
                {
                  title: "操作",
                  key: "actions",
                  render: (_: unknown, row: { key: string; value: string }) => (
                    <>
                      <Button
                        size="small"
                        type="link"
                        onClick={() => {
                          varForm.setFieldsValue(row);
                          setVarModal({ key: row.key });
                        }}
                      >
                        编辑
                      </Button>
                      <Popconfirm
                        title={`确认删除「${row.key}」？`}
                        okText="删除"
                        cancelText="取消"
                        onConfirm={() => void removeVar(row.key)}
                      >
                        <Button size="small" type="link" danger>
                          删除
                        </Button>
                      </Popconfirm>
                    </>
                  ),
                },
              ]),
        ]}
      />

      <div style={{ margin: "16px 0 8px" }}>
        <span style={{ fontWeight: 600 }}>安全配置（secrets）</span>
        <Tooltip title="机密键值（令牌、凭据）。只写不回显：此处只能看到键名；改值 = 新增同名键覆盖。">
          <QuestionCircleOutlined style={{ marginLeft: 6, color: "#999" }} />
        </Tooltip>
        {!readOnly && (
          <Button
            size="small"
            style={{ marginLeft: 12 }}
            onClick={() => {
              secretForm.resetFields();
              setSecretModalOpen(true);
            }}
          >
            新增机密
          </Button>
        )}
      </div>
      <Table
        rowKey="key"
        size="small"
        loading={loading}
        dataSource={view.secret_keys.map((key) => ({ key }))}
        pagination={false}
        columns={[
          { title: "键", dataIndex: "key" },
          {
            title: "值",
            key: "masked",
            render: () => <Tag>已配置（值不回显）</Tag>,
          },
          ...(readOnly
            ? []
            : [
                {
                  title: "操作",
                  key: "actions",
                  render: (_: unknown, row: { key: string }) => (
                    <Popconfirm
                      title={`确认删除机密「${row.key}」？`}
                      okText="删除"
                      cancelText="取消"
                      onConfirm={() => void removeSecret(row.key)}
                    >
                      <Button size="small" type="link" danger>
                        删除
                      </Button>
                    </Popconfirm>
                  ),
                },
              ]),
        ]}
      />

      <Modal
        title={varModal?.key !== undefined ? "编辑配置" : "新增配置"}
        open={varModal !== null}
        onOk={() => void saveVar()}
        onCancel={() => setVarModal(null)}
        confirmLoading={submitting}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={varForm} layout="vertical" preserve={false}>
          <Form.Item
            name="key"
            label="键"
            rules={[
              { required: true, whitespace: true, message: "键不能为空" },
            ]}
          >
            <Input aria-label="配置键" disabled={varModal?.key !== undefined} />
          </Form.Item>
          <Form.Item
            name="value"
            label="值"
            rules={[{ required: true, message: "值不能为空" }]}
          >
            <Input aria-label="配置值" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="新增机密"
        open={secretModalOpen}
        onOk={() => void saveSecret()}
        onCancel={() => setSecretModalOpen(false)}
        confirmLoading={submitting}
        okText="写入"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={secretForm} layout="vertical" preserve={false}>
          <Form.Item
            name="key"
            label="键"
            rules={[
              { required: true, whitespace: true, message: "键不能为空" },
            ]}
          >
            <Input aria-label="机密键" placeholder="如 jira_token" />
          </Form.Item>
          <Form.Item
            name="value"
            label="值"
            rules={[{ required: true, message: "值不能为空" }]}
            extra="写入后不再回显；同名键重复写入即覆盖。"
          >
            <Input.Password aria-label="机密值" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
