import { screen, waitFor } from "@testing-library/react";
import type { TaskView } from "@asteriskzuo/agent-console-api";
import { MEMBER_USER, installFetchMock, renderApp, setupUser } from "./helpers";
import type { RecordedCall } from "./helpers";

/** 定时任务视图 mock（GET /api/businesses/biz-1/scheduled-tasks 响应） */
const TASKS: TaskView[] = [
  {
    name: "warmup",
    program: "warmup",
    every_minutes: 720,
    timeout_minutes: 60,
    last_run: {
      run_id: "run_0123456789ABCDEFGHJKMNPQRS",
      status: "success",
      created_at: "2026-11-13T00:00:00.000Z",
      finished_at: "2026-11-13T00:00:05.000Z",
    },
  },
];

const BIZ_DETAIL = {
  profile: {
    business_id: "biz-1",
    business_name: "定时任务业务",
    creator_id: MEMBER_USER.user_id,
    on_failure: false,
    prompt: "",
    model: "qwen/qwen3.8-max",
    agent_kind: "pi",
    package_asset_id: "pkg-1",
    entry_program: "main",
    tool_asset_ids: [],
    skill_asset_ids: [],
  },
  matches: [],
  exit_bindings: [],
};

/** 编辑页通用 mock；tasks = undefined 时清单为空（区块应不渲染）；runConflict = true 时 POST 返回 409 */
function installMocks(over: { emptyTasks?: boolean; runConflict?: boolean }) {
  return installFetchMock((path, { method }) => {
    if (path === "/api/auth/me") return { status: 200, body: MEMBER_USER };
    if (path === "/api/config") {
      return { status: 200, body: { agents: ["pi"], entry_adapters: [] } };
    }
    if (path === "/api/businesses/biz-1/pi-config" && method === "GET") {
      return {
        status: 200,
        body: { configured: true, model: "qwen/qwen3.8-max" },
      };
    }
    if (path === "/api/exit-tools") return { status: 200, body: [] };
    if (path === "/api/assets?kind=package&scope=mine") {
      return { status: 200, body: [] };
    }
    if (path === "/api/assets?kind=tool&scope=all") {
      return { status: 200, body: [] };
    }
    if (path === "/api/assets?kind=skill&scope=all") {
      return { status: 200, body: [] };
    }
    if (path === "/api/businesses" && method === "GET") {
      return { status: 200, body: [] };
    }
    if (path === "/api/businesses/biz-1" && method === "GET") {
      return { status: 200, body: BIZ_DETAIL };
    }
    if (path === "/api/env/businesses/biz-1" && method === "GET") {
      return { status: 200, body: { vars: {}, secret_keys: [] } };
    }
    if (path === "/api/businesses/biz-1/scheduled-tasks" && method === "GET") {
      return { status: 200, body: { tasks: over.emptyTasks ? [] : TASKS } };
    }
    if (
      path === "/api/businesses/biz-1/scheduled-tasks/warmup/run" &&
      method === "POST"
    ) {
      if (over.runConflict === true) {
        return {
          status: 409,
          body: {
            error: {
              code: "conflict",
              message: "scheduled_task_running: biz-1/warmup",
            },
          },
        };
      }
      return { status: 202, body: { run_id: "run_new" } };
    }
    return undefined;
  });
}

const runCalls = (calls: RecordedCall[]) =>
  calls.filter((c) => c.path.endsWith("/scheduled-tasks/warmup/run"));

describe("业务编辑页「定时任务」区", () => {
  it("列表非空 → 区块显示：名称/程序/节奏/超时/最近状态/最近运行时间/立即执行按钮", async () => {
    installMocks({});
    renderApp("/businesses/biz-1");
    // 表格内容
    expect(await screen.findByText("定时任务")).toBeTruthy();
    // fixture 中任务名与程序名同为 "warmup"，名称/程序两列各渲染一次，故用 findAllByText
    expect((await screen.findAllByText("warmup")).length).toBeGreaterThan(0);
    expect(screen.getByText("每 720 分钟")).toBeTruthy();
    expect(screen.getByText("60 分钟")).toBeTruthy();
    expect(screen.getByText("success")).toBeTruthy();
    expect(screen.getByText("2026-11-13T00:00:00.000Z")).toBeTruthy();
    expect(screen.getByLabelText("立即执行 warmup")).toBeTruthy();
  });

  it("点击「立即执行」→ POST 发起 → 成功提示 → 重新拉取清单", async () => {
    const calls = installMocks({});
    const user = setupUser();
    renderApp("/businesses/biz-1");
    await user.click(await screen.findByLabelText("立即执行 warmup"));
    await screen.findByText("已发起执行（任务 warmup），运行记录稍后可见");
    expect(runCalls(calls)).toHaveLength(1);
    expect(runCalls(calls)[0].method).toBe("POST");
    // 完成后刷新列表：GET scheduled-tasks 至少两次（初始加载 + 执行后刷新）
    await waitFor(() => {
      const gets = calls.filter(
        (c) => c.path.endsWith("/scheduled-tasks") && c.method === "GET",
      );
      expect(gets.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("POST 409 → 提示「该任务正在运行」", async () => {
    installMocks({ runConflict: true });
    const user = setupUser();
    renderApp("/businesses/biz-1");
    await user.click(await screen.findByLabelText("立即执行 warmup"));
    expect(await screen.findByText("该任务正在运行")).toBeTruthy();
  });

  it("清单为空 → 区块不渲染", async () => {
    installMocks({ emptyTasks: true });
    renderApp("/businesses/biz-1");
    // 等页面加载完成（业务名回填即编辑态详情已就位）
    expect(await screen.findByLabelText("业务名称")).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText("定时任务")).toBeNull();
    });
  });
});
