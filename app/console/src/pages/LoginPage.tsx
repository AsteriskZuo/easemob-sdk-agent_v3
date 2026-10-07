import { useState } from "react";
import { Alert, Button, Card, Form, Input } from "antd";
import { Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

/** 登录页：居中卡片；失败统一提示「用户名或密码错误」（不区分原因，防枚举） */
export default function LoginPage() {
  const { user, loading, login } = useAuth();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 已登录访问 /login → 重定向首页
  if (!loading && user !== null) {
    return <Navigate to="/" replace />;
  }

  const onFinish = async (values: { username: string; password: string }) => {
    setSubmitting(true);
    setFailed(false);
    try {
      await login(values.username, values.password);
      navigate("/");
    } catch {
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        background: "#f0f2f5",
      }}
    >
      <Card title="智能体平台控制台" style={{ width: 360 }}>
        {failed && (
          <Alert
            type="error"
            message="用户名或密码错误"
            style={{ marginBottom: 16 }}
            showIcon
          />
        )}
        <Form layout="vertical" onFinish={(v) => void onFinish(v)}>
          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: "请输入用户名" }]}
          >
            <Input aria-label="用户名" autoFocus />
          </Form.Item>
          <Form.Item
            name="password"
            label="密码"
            rules={[{ required: true, message: "请输入密码" }]}
          >
            <Input.Password aria-label="密码" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={submitting}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
