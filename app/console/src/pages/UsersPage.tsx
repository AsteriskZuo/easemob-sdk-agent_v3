import { useCallback, useEffect, useState } from "react";
import {
  App as AntdApp,
  Button,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Table,
  Tag,
  Tooltip,
} from "antd";
import { QuestionCircleOutlined } from "@ant-design/icons";
import { Navigate } from "react-router-dom";
import type {
  CreateUserBody,
  Role,
  User,
} from "@asteriskzuo/agent-console-api";
import { apiFetch, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";

/** 用户管理（仅 admin；member 访问直接重定向首页——前端藏入口 + 路由兜底，真权限在 API） */
export default function UsersPage() {
  const { user: me } = useAuth();
  const { message } = AntdApp.useApp();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm<CreateUserBody>();

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await apiFetch<User[]>("/api/users"));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : "加载用户失败");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (me?.role === "admin") void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.role]);

  if (me === null) return null;
  if (me.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  const createUser = async () => {
    let values: CreateUserBody;
    try {
      values = await form.validateFields();
    } catch {
      return; // 校验失败：antd 已在表单内报错
    }
    setSubmitting(true);
    try {
      await apiFetch<User>("/api/users", { method: "POST", body: values });
      message.success("账号已创建");
      setCreateOpen(false);
      form.resetFields();
      await reload();
    } catch (err) {
      message.error(
        err instanceof ApiError
          ? err.code === "conflict"
            ? "用户名已存在"
            : err.message
          : "创建失败",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const setDisabled = async (target: User, disabled: boolean) => {
    try {
      await apiFetch<void>(`/api/users/${target.user_id}/disabled`, {
        method: "POST",
        body: { disabled },
      });
      message.success(disabled ? "已停用" : "已启用");
      await reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : "操作失败");
    }
  };

  return (
    <div>
      <div style={{ marginBottom: 16, display: "flex", alignItems: "center" }}>
        <h2 style={{ margin: 0, flex: 1 }}>
          用户管理
          <Tooltip title="平台不开放注册：账号由管理员在此创建。停用代替删除——历史业务记录仍指向被停用的创建者。">
            <QuestionCircleOutlined style={{ marginLeft: 8, color: "#999" }} />
          </Tooltip>
        </h2>
        <Button type="primary" onClick={() => setCreateOpen(true)}>
          创建账号
        </Button>
      </div>
      <Table
        rowKey="user_id"
        loading={loading}
        dataSource={users}
        pagination={false}
        onRow={(row) => ({
          style: row.disabled ? { opacity: 0.5 } : undefined,
        })}
        columns={[
          { title: "展示名", dataIndex: "display_name" },
          { title: "用户名", dataIndex: "username" },
          {
            title: "角色",
            dataIndex: "role",
            render: (role: Role) => (
              <Tag color={role === "admin" ? "gold" : "blue"}>
                {role === "admin" ? "管理员" : "成员"}
              </Tag>
            ),
          },
          {
            title: "状态",
            dataIndex: "disabled",
            render: (disabled: boolean) =>
              disabled ? (
                <Tag color="red">已停用</Tag>
              ) : (
                <Tag color="green">启用中</Tag>
              ),
          },
          { title: "创建时间", dataIndex: "created_at" },
          {
            title: "操作",
            key: "actions",
            render: (_: unknown, row: User) =>
              row.user_id === me.user_id ? null : (
                <Popconfirm
                  title={
                    row.disabled
                      ? `确认启用「${row.display_name}」？`
                      : `确认停用「${row.display_name}」？停用后其会话立即失效。`
                  }
                  okText="确认"
                  cancelText="取消"
                  onConfirm={() => void setDisabled(row, !row.disabled)}
                >
                  <Button size="small" type="link" danger={!row.disabled}>
                    {row.disabled ? "启用" : "停用"}
                  </Button>
                </Popconfirm>
              ),
          },
        ]}
      />

      <Modal
        title="创建账号"
        open={createOpen}
        onOk={() => void createUser()}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={submitting}
        okText="创建"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="username"
            label="用户名（登录名，创建后不可改）"
            rules={[
              { required: true, whitespace: true, message: "请输入用户名" },
            ]}
          >
            <Input aria-label="用户名" />
          </Form.Item>
          <Form.Item
            name="display_name"
            label="展示名"
            rules={[
              { required: true, whitespace: true, message: "请输入展示名" },
            ]}
          >
            <Input aria-label="展示名" />
          </Form.Item>
          <Form.Item
            name="password"
            label="初始密码"
            rules={[{ required: true, message: "请输入初始密码" }]}
          >
            <Input.Password aria-label="初始密码" />
          </Form.Item>
          <Form.Item
            name="role"
            label="角色"
            initialValue="member"
            rules={[{ required: true }]}
          >
            <Select
              aria-label="角色"
              options={[
                { value: "member", label: "成员（业务/资产操作）" },
                { value: "admin", label: "管理员（平台管理）" },
              ]}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
