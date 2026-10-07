import { useState } from "react";
import {
  DashboardOutlined,
  AppstoreOutlined,
  CloudOutlined,
  SettingOutlined,
  TeamOutlined,
  UserOutlined,
} from "@ant-design/icons";
import {
  App as AntdApp,
  Dropdown,
  Form,
  Input,
  Layout,
  Menu,
  Modal,
  Tag,
} from "antd";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";

const { Sider, Header, Content } = Layout;

/** 主导航（按使用频率序；用户管理仅 admin 可见） */
const NAV_ITEMS = [
  { key: "/", icon: <DashboardOutlined />, label: "监控仪表盘" },
  { key: "/businesses", icon: <AppstoreOutlined />, label: "业务管理" },
  { key: "/assets", icon: <CloudOutlined />, label: "资产管理" },
  { key: "/settings", icon: <SettingOutlined />, label: "通用配置" },
  { key: "/users", icon: <TeamOutlined />, label: "用户管理", adminOnly: true },
];

/** 主布局：左侧导航 + 右上角用户菜单（修改密码 / 退出登录）+ 内容区（Outlet） */
export default function AppLayout() {
  const { user, logout, changePassword } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { message } = AntdApp.useApp();
  const [pwdOpen, setPwdOpen] = useState(false);
  const [pwdSubmitting, setPwdSubmitting] = useState(false);
  const [pwdForm] = Form.useForm<{
    old_password: string;
    new_password: string;
  }>();

  if (user === null) return null; // 守卫已保证非空，此处仅收窄类型

  const items = NAV_ITEMS.filter(
    (item) => !item.adminOnly || user.role === "admin",
  ).map(({ key, icon, label }) => ({ key, icon, label }));

  // 业务编辑页高亮「业务管理」
  const selectedKey = location.pathname.startsWith("/businesses")
    ? "/businesses"
    : location.pathname === "/"
      ? "/"
      : `/${location.pathname.split("/")[1]}`;

  const submitPassword = async () => {
    let values: { old_password: string; new_password: string };
    try {
      values = await pwdForm.validateFields();
    } catch {
      return; // 校验失败：antd 已在表单内报错
    }
    setPwdSubmitting(true);
    try {
      await changePassword(values.old_password, values.new_password);
      message.success("密码已修改，其它会话已失效");
      setPwdOpen(false);
      pwdForm.resetFields();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : "修改失败");
    } finally {
      setPwdSubmitting(false);
    }
  };

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider theme="dark">
        <div
          style={{
            color: "#fff",
            padding: "16px",
            fontWeight: 600,
            fontSize: 15,
          }}
        >
          智能体平台控制台
        </div>
        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={items}
          onClick={({ key }) => navigate(key)}
        />
      </Sider>
      <Layout>
        <Header
          style={{
            background: "#fff",
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            padding: "0 24px",
          }}
        >
          <Dropdown
            menu={{
              items: [
                { key: "password", label: "修改密码" },
                { key: "logout", label: "退出登录" },
              ],
              onClick: ({ key }) => {
                if (key === "password") setPwdOpen(true);
                if (key === "logout") {
                  void logout().then(() => navigate("/login"));
                }
              },
            }}
          >
            <span style={{ cursor: "pointer" }}>
              <UserOutlined style={{ marginRight: 8 }} />
              {user.display_name}
              <Tag
                style={{ marginLeft: 8 }}
                color={user.role === "admin" ? "gold" : "blue"}
              >
                {user.role === "admin" ? "管理员" : "成员"}
              </Tag>
            </span>
          </Dropdown>
        </Header>
        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </Layout>

      <Modal
        title="修改密码"
        open={pwdOpen}
        onOk={() => void submitPassword()}
        onCancel={() => setPwdOpen(false)}
        confirmLoading={pwdSubmitting}
        okText="确认修改"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={pwdForm} layout="vertical" preserve={false}>
          <Form.Item
            name="old_password"
            label="旧密码"
            rules={[{ required: true, message: "请输入旧密码" }]}
          >
            <Input.Password aria-label="旧密码" />
          </Form.Item>
          <Form.Item
            name="new_password"
            label="新密码"
            rules={[{ required: true, message: "请输入新密码" }]}
          >
            <Input.Password aria-label="新密码" />
          </Form.Item>
        </Form>
      </Modal>
    </Layout>
  );
}
