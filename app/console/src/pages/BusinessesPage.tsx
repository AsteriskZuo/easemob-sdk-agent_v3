import { useCallback, useEffect, useState } from "react";
import {
  App as AntdApp,
  Button,
  Empty,
  Popconfirm,
  Table,
  Tag,
  Tooltip,
} from "antd";
import { PlusOutlined, QuestionCircleOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import type { BusinessProfile } from "@asterisk/agent-console-api";
import { apiFetch, ApiError } from "../api/client";

/** 业务列表（注册表视图）：名称/id/agent/model/包绑定状态/创建者；编辑、删除 */
export default function BusinessesPage() {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const [businesses, setBusinesses] = useState<BusinessProfile[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setBusinesses(await apiFetch<BusinessProfile[]>("/api/businesses"));
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : "加载业务列表失败");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (businessId: string) => {
    try {
      await apiFetch<void>(`/api/businesses/${businessId}`, {
        method: "DELETE",
      });
      message.success("已删除");
      await reload();
    } catch (err) {
      message.error(err instanceof ApiError ? err.message : "删除失败");
    }
  };

  if (!loading && businesses.length === 0) {
    // 空状态引导：无业务时给创建入口（易用性三原则之一）
    return (
      <Empty
        description="还没有业务。业务是平台的最小运行单元：匹配到事件后跑一次 agent 流程。"
        style={{ marginTop: 120 }}
      >
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => navigate("/businesses/new")}
        >
          创建第一个业务
        </Button>
      </Empty>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 16, display: "flex", alignItems: "center" }}>
        <h2 style={{ margin: 0, flex: 1 }}>
          业务管理
          <Tooltip title="业务 = 匹配规则 + 执行配置（包/工具/skill/模型/总纲）。只有创建者或管理员可改可删。">
            <QuestionCircleOutlined style={{ marginLeft: 8, color: "#999" }} />
          </Tooltip>
        </h2>
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={() => navigate("/businesses/new")}
        >
          创建业务
        </Button>
      </div>
      <Table
        rowKey="business_id"
        loading={loading}
        dataSource={businesses}
        pagination={false}
        columns={[
          { title: "名称", dataIndex: "business_name" },
          { title: "业务 ID", dataIndex: "business_id" },
          { title: "Agent", dataIndex: "agent_kind" },
          { title: "模型", dataIndex: "model" },
          {
            title: "包绑定",
            key: "package",
            render: (_, row: BusinessProfile) =>
              row.package_asset_id !== undefined ? (
                <Tag color="green">已绑定</Tag>
              ) : (
                <Tag color="orange">未绑定</Tag>
              ),
          },
          { title: "创建者", dataIndex: "creator_id" },
          {
            title: "操作",
            key: "actions",
            render: (_: unknown, row: BusinessProfile) => (
              <>
                <Button
                  size="small"
                  type="link"
                  onClick={() => navigate(`/businesses/${row.business_id}`)}
                >
                  编辑
                </Button>
                <Popconfirm
                  title={`确认删除业务「${row.business_name}」？匹配行与出口绑定一并删除。`}
                  okText="删除"
                  cancelText="取消"
                  onConfirm={() => void remove(row.business_id)}
                >
                  <Button size="small" type="link" danger>
                    删除
                  </Button>
                </Popconfirm>
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
