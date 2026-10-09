import { useCallback, useEffect, useState } from "react";
import {
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  Row,
  Select,
  Statistic,
  Table,
  Tag,
} from "antd";
import type {
  BusinessProfile,
  LifecycleRecord,
  LifecycleStatus,
  QueuesStatus,
  Task,
  TaskStatus,
} from "@asteriskzuo/agent-console-api";
import { apiFetch, ApiError } from "../api/client";

/** 队列四状态计数卡片 */
function QueueCard({
  title,
  counts,
}: {
  title: string;
  counts?: QueuesStatus["entry"];
}) {
  return (
    <Card title={title}>
      <Row gutter={16}>
        <Col span={6}>
          <Statistic title="待取" value={counts?.pending ?? "-"} />
        </Col>
        <Col span={6}>
          <Statistic title="消化中" value={counts?.processing ?? "-"} />
        </Col>
        <Col span={6}>
          <Statistic title="完结" value={counts?.done ?? "-"} />
        </Col>
        <Col span={6}>
          <Statistic title="死信" value={counts?.dead ?? "-"} />
        </Col>
      </Row>
    </Card>
  );
}

/** 运行状态徽标颜色：running 蓝 / success 绿 / failed 红 / timeout 橙 */
const RUN_STATUS_COLOR: Record<LifecycleStatus, string> = {
  created: "default",
  running: "blue",
  success: "green",
  failed: "red",
  timeout: "orange",
};

interface TaskFilter {
  queue: "entry" | "exit";
  status?: TaskStatus;
  event_id?: string;
  correlation_id?: string;
}

/** 监控仪表盘：队列计数（5 秒轮询）+ 任务查询 + 业务运行记录（全部只读） */
export default function DashboardPage() {
  const { message } = AntdApp.useApp();
  const [queues, setQueues] = useState<QueuesStatus | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [businesses, setBusinesses] = useState<BusinessProfile[]>([]);
  const [selectedBusiness, setSelectedBusiness] = useState<string | null>(null);
  const [runs, setRuns] = useState<LifecycleRecord[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [filterForm] = Form.useForm<TaskFilter>();

  const reportError = useCallback(
    (err: unknown, fallback: string) => {
      message.error(err instanceof ApiError ? err.message : fallback);
    },
    [message],
  );

  // 队列计数 5 秒轮询
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      apiFetch<QueuesStatus>("/api/monitor/queues")
        .then((data) => {
          if (!cancelled) setQueues(data);
        })
        .catch(() => {
          // 轮询失败不打扰（保留旧值），下次 tick 自愈
        });
    };
    load();
    const timer = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // 业务下拉数据源
  useEffect(() => {
    apiFetch<BusinessProfile[]>("/api/businesses")
      .then(setBusinesses)
      .catch((err: unknown) => reportError(err, "加载业务列表失败"));
  }, [reportError]);

  const queryTasks = async (values: TaskFilter) => {
    setTasksLoading(true);
    try {
      const params = new URLSearchParams({ queue: values.queue });
      if (values.status !== undefined) params.set("status", values.status);
      if (values.event_id) params.set("event_id", values.event_id);
      if (values.correlation_id) {
        params.set("correlation_id", values.correlation_id);
      }
      setTasks(await apiFetch<Task[]>(`/api/monitor/tasks?${params}`));
    } catch (err) {
      reportError(err, "查询任务失败");
    } finally {
      setTasksLoading(false);
    }
  };

  const loadRuns = useCallback(
    async (businessId: string) => {
      setRunsLoading(true);
      try {
        setRuns(
          await apiFetch<LifecycleRecord[]>(
            `/api/businesses/${businessId}/runs`,
          ),
        );
      } catch (err) {
        reportError(err, "加载运行记录失败");
      } finally {
        setRunsLoading(false);
      }
    },
    [reportError],
  );

  return (
    <div>
      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={12}>
          <QueueCard title="入口队列" counts={queues?.entry} />
        </Col>
        <Col span={12}>
          <QueueCard title="出口队列" counts={queues?.exit} />
        </Col>
      </Row>

      <Card title="任务查询" style={{ marginBottom: 24 }}>
        <Form
          form={filterForm}
          layout="inline"
          initialValues={{ queue: "entry" }}
          onFinish={(v) => void queryTasks(v)}
          style={{ marginBottom: 16 }}
        >
          <Form.Item
            name="queue"
            label="队列"
            rules={[{ required: true, message: "必选队列" }]}
          >
            <Select
              aria-label="队列"
              style={{ width: 120 }}
              options={[
                { value: "entry", label: "入口" },
                { value: "exit", label: "出口" },
              ]}
            />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select
              aria-label="任务状态"
              allowClear
              style={{ width: 120 }}
              options={(
                ["pending", "processing", "done", "dead"] as TaskStatus[]
              ).map((s) => ({ value: s, label: s }))}
            />
          </Form.Item>
          <Form.Item name="event_id" label="事件 ID">
            <Input aria-label="事件 ID" allowClear />
          </Form.Item>
          <Form.Item name="correlation_id" label="关联 ID">
            <Input aria-label="关联 ID" allowClear />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit">
              查询
            </Button>
          </Form.Item>
        </Form>
        <Table
          rowKey="task_id"
          size="small"
          loading={tasksLoading}
          dataSource={tasks}
          expandable={{
            expandedRowRender: (task) => (
              <pre style={{ margin: 0, fontSize: 12 }}>
                {JSON.stringify(task.event, null, 2)}
              </pre>
            ),
          }}
          columns={[
            { title: "任务 ID", dataIndex: "task_id" },
            {
              title: "状态",
              dataIndex: "status",
              render: (status: TaskStatus) => <Tag>{status}</Tag>,
            },
            { title: "事件类型", render: (_, task) => task.event.event_type },
            { title: "来源", render: (_, task) => task.event.source },
            { title: "入队时间", dataIndex: "enqueued_at" },
            {
              title: "完结时间",
              dataIndex: "finished_at",
              render: (v?: string) => v ?? "—",
            },
          ]}
        />
      </Card>

      <Card title="业务运行记录">
        <div style={{ marginBottom: 16 }}>
          <Select
            aria-label="选择业务"
            style={{ width: 320 }}
            placeholder="选择业务查看运行记录"
            value={selectedBusiness}
            options={businesses.map((b) => ({
              value: b.business_id,
              label: b.business_name,
            }))}
            onChange={(id) => {
              setSelectedBusiness(id);
              void loadRuns(id);
            }}
          />
        </div>
        <Table
          rowKey="lifecycle_id"
          size="small"
          loading={runsLoading}
          dataSource={runs}
          columns={[
            { title: "运行 ID", dataIndex: "lifecycle_id" },
            {
              title: "状态",
              dataIndex: "status",
              render: (status: LifecycleStatus) => (
                <Tag color={RUN_STATUS_COLOR[status]}>{status}</Tag>
              ),
            },
            { title: "创建时间", dataIndex: "created_at" },
            {
              title: "完结时间",
              dataIndex: "finished_at",
              render: (v?: string) => v ?? "—",
            },
          ]}
        />
      </Card>
    </div>
  );
}
