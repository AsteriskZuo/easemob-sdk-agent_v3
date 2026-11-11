import { screen, within } from "@testing-library/react";
import dayjs from "dayjs";
import {
  ADMIN_USER,
  installFetchMock,
  renderApp,
  selectOption,
  setupUser,
} from "./helpers";
import type { StatsRow } from "../src/stats";

const BUSINESS = { business_id: "biz-1", business_name: "工单评审" };

/** 契约 C 形状的 mock 响应：只在「今天」有数据（含 llm.errors），其余日期零数据补零 */
function statsBody() {
  const to = dayjs().format("YYYY-MM-DD");
  const from = dayjs().subtract(13, "day").format("YYYY-MM-DD");
  const row = (metric: string, value: number, bucket = ""): StatsRow => ({
    date: to,
    metric,
    bucket,
    value,
  });
  return {
    business_id: BUSINESS.business_id,
    from,
    to,
    rows: [
      row("run.total", 3),
      row("run.success", 2),
      row("run.failed", 1),
      row("run.timeout", 0),
      row("run.failed_phase", 1, "main"),
      row("run.avg_duration_ms", 1500),
      row("llm.calls", 4),
      row("llm.tokens.input", 12345),
      row("llm.tokens.output", 678),
      row("llm.tokens.cache_read", 0),
      row("llm.tokens.cache_write", 0),
      row("llm.cost", 0.123456),
      row("llm.avg_duration_ms", 2345),
      row("llm.calls_without_usage", 1),
      row("llm.errors", 2, "agent_failed"),
    ],
  };
}

function installMocks() {
  return installFetchMock((path) => {
    if (path === "/api/auth/me") return { status: 200, body: ADMIN_USER };
    if (path === "/api/businesses") return { status: 200, body: [BUSINESS] };
    if (path.startsWith("/api/stats/daily?")) {
      return { status: 200, body: statsBody() };
    }
    return undefined;
  });
}

describe("统计页", () => {
  it("选业务后按契约 C 透视渲染：格式化、补零行、错误明细", async () => {
    const calls = installMocks();
    renderApp("/stats");

    // 未选业务：不查统计接口
    expect(await screen.findByText("请先选择业务")).toBeTruthy();
    expect(calls.some((c) => c.path.startsWith("/api/stats/daily"))).toBe(
      false,
    );

    const user = setupUser();
    await selectOption(user, "选择业务", BUSINESS.business_name);

    // 请求带 business_id 与默认近 14 天区间
    await screen.findByText("12,345"); // llm.tokens.input 千分位
    const statsCall = calls.find((c) => c.path.startsWith("/api/stats/daily"));
    expect(statsCall?.path).toContain(`business_id=${BUSINESS.business_id}`);
    expect(statsCall?.path).toContain(
      `from=${dayjs().subtract(13, "day").format("YYYY-MM-DD")}`,
    );
    expect(statsCall?.path).toContain(`to=${dayjs().format("YYYY-MM-DD")}`);

    // 格式化：成本 $ 4 位小数、耗时 ms→s、无用量次
    expect(screen.getByText("$0.1235")).toBeTruthy();
    expect(screen.getByText("1.5 s")).toBeTruthy(); // run.avg_duration_ms=1500
    expect(screen.getByText("2.3 s")).toBeTruthy(); // llm.avg_duration_ms=2345

    // 零数据日补零行：13 天前的日期行存在（该行计数全 0，日期格可锚定）
    expect(
      screen.getByText(dayjs().subtract(13, "day").format("YYYY-MM-DD")),
    ).toBeTruthy();

    // 错误明细小节：llm.errors 动态桶单独出表，不进主表列
    expect(screen.getByText("错误明细")).toBeTruthy();
    expect(screen.getByText("agent_failed")).toBeTruthy();

    // 无 biz.* 行：「业务」列组整体不出现（th 锚定，避开业务下拉占位文案）
    expect(screen.queryByText("业务", { selector: "th" })).toBeNull();
  });

  it("biz.* 行渲染「业务」列组：字符串动态列 + 数值三列，缺失日显示 -", async () => {
    const to = dayjs().format("YYYY-MM-DD");
    const from = dayjs().subtract(13, "day").format("YYYY-MM-DD");
    const row = (metric: string, value: number, bucket = ""): StatsRow => ({
      date: to,
      metric,
      bucket,
      value,
    });
    installFetchMock((path) => {
      if (path === "/api/auth/me") return { status: 200, body: ADMIN_USER };
      if (path === "/api/businesses") return { status: 200, body: [BUSINESS] };
      if (path.startsWith("/api/stats/daily?")) {
        return {
          status: 200,
          body: {
            business_id: BUSINESS.business_id,
            from,
            to,
            rows: [
              row("run.total", 1),
              row("biz.decision", 7, "pass"),
              row("biz.decision", 8, "reject"),
              row("biz.score.sum", 30),
              row("biz.score.avg", 3.14159),
              row("biz.score.count", 9),
            ],
          },
        };
      }
      return undefined;
    });
    renderApp("/stats");

    // 等守卫与页面就绪（me/businesses 返回后再操作下拉）
    expect(await screen.findByText("请先选择业务")).toBeTruthy();
    const user = setupUser();
    await selectOption(user, "选择业务", BUSINESS.business_name);

    // 列组标题与子列（key 字典序：decision 桶字典序 → score 三列固定序）
    await screen.findByText("业务", { selector: "th" });
    // 锚定主表（运行统计卡片），避开「错误明细」表的表头
    const mainCard = screen.getByText("运行统计").closest(".ant-card");
    expect(mainCard).not.toBeNull();
    const headers = within(mainCard as HTMLElement)
      .getAllByRole("columnheader")
      .map((th) => th.textContent);
    expect(headers.slice(-5)).toEqual([
      "decision=pass",
      "decision=reject",
      "score.sum",
      "score.avg",
      "score.count",
    ]);

    // 单元格：字符串桶计数、数值 sum/avg（2 位小数）/count
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("8")).toBeTruthy();
    expect(screen.getByText("30")).toBeTruthy();
    expect(screen.getByText("3.14")).toBeTruthy();
    expect(screen.getByText("9")).toBeTruthy();

    // 零数据日无 biz 数据：单元格显示 -（run.avg 等 null 列也是 -，取全部即可）
    expect(screen.getAllByText("-").length).toBeGreaterThan(0);
  });

  it("统计接口报错时提示且不崩页", async () => {
    installFetchMock((path) => {
      if (path === "/api/auth/me") return { status: 200, body: ADMIN_USER };
      if (path === "/api/businesses") return { status: 200, body: [BUSINESS] };
      if (path.startsWith("/api/stats/daily?")) {
        return {
          status: 404,
          body: { error: { code: "not_found", message: "业务不存在" } },
        };
      }
      return undefined;
    });
    renderApp("/stats");
    // 等守卫与页面就绪（me/businesses 返回后再操作下拉）
    expect(await screen.findByText("请先选择业务")).toBeTruthy();
    const user = setupUser();
    await selectOption(user, "选择业务", BUSINESS.business_name);
    expect(await screen.findByText("业务不存在")).toBeTruthy();
  });

  it("日期详情：点日期出当日明细，行展开看失败原因/LLM 调用/业务指标/日志", async () => {
    const to = dayjs().format("YYYY-MM-DD");
    const run = {
      lifecycle_id: "run_01JTEST0000000000000000001",
      business_id: BUSINESS.business_id,
      event_id: "evt-1",
      channel_id: "ch-1",
      status: "failed",
      created_at: `${to}T02:00:00.000Z`,
      finished_at: `${to}T02:00:01.500Z`,
      failed_at: "main",
      reason: "exit code 1",
    };
    const detail = {
      record: run,
      llm_calls: [
        {
          run_id: run.lifecycle_id,
          business_id: BUSINESS.business_id,
          ts: `${to}T02:00:01.000Z`,
          op: "agent",
          model: "openai/gpt-x",
          skills: [],
          mode: "channel",
          ok: false,
          error: "agent_failed",
          duration_ms: 1234,
          input_tokens: 100,
          output_tokens: 50,
        },
      ],
      metrics: [{ key: "decision", value: "pass" }],
    };
    const calls = installFetchMock((path) => {
      if (path === "/api/auth/me") return { status: 200, body: ADMIN_USER };
      if (path === "/api/businesses") return { status: 200, body: [BUSINESS] };
      if (path.startsWith("/api/stats/daily?")) {
        return { status: 200, body: statsBody() };
      }
      if (path === `/api/businesses/${BUSINESS.business_id}/runs?date=${to}`) {
        return { status: 200, body: [run] };
      }
      if (path === `/api/runs/${run.lifecycle_id}/detail`) {
        return { status: 200, body: detail };
      }
      if (path === `/api/runs/${run.lifecycle_id}/log`) {
        return {
          status: 200,
          body: {
            run_id: run.lifecycle_id,
            path: `businesses/${BUSINESS.business_id}/logs/jira/HIM-1/${run.lifecycle_id}.log`,
            content: "line1\nline2",
            truncated: false,
            size: 11,
          },
        };
      }
      return undefined;
    });
    renderApp("/stats");
    expect(await screen.findByText("请先选择业务")).toBeTruthy();
    const user = setupUser();
    await selectOption(user, "选择业务", BUSINESS.business_name);
    await screen.findByText("$0.1235"); // 主表就绪

    // 点日期（主表内锚定，错误明细表也有当天日期）→ 日期详情卡片 + runs?date= 请求
    const mainCard = screen.getByText("运行统计").closest(
      ".ant-card",
    ) as HTMLElement;
    await user.click(within(mainCard).getByText(to));
    expect(await screen.findByText(`日期详情 ${to}`)).toBeTruthy();
    expect(
      calls.some(
        (c) => c.path === `/api/businesses/${BUSINESS.business_id}/runs?date=${to}`,
      ),
    ).toBe(true);
    const detailCard = screen.getByText(`日期详情 ${to}`).closest(
      ".ant-card",
    ) as HTMLElement;
    // 当日明细行：事件 ID/耗时/失败阶段/失败原因
    expect(await within(detailCard).findByText("evt-1")).toBeTruthy();
    expect(within(detailCard).getByText("1.5 s")).toBeTruthy();
    expect(within(detailCard).getByText("main")).toBeTruthy();
    expect(within(detailCard).getByText("exit code 1")).toBeTruthy();

    // 行展开 → 懒调 detail：失败原因红字 + LLM 调用表 + 业务指标表
    const expandIcon = detailCard.querySelector(
      ".ant-table-row-expand-icon",
    ) as HTMLElement;
    await user.click(expandIcon);
    expect(
      await within(detailCard).findByText("失败原因：exit code 1"),
    ).toBeTruthy();
    expect(within(detailCard).getByText("openai/gpt-x")).toBeTruthy();
    expect(within(detailCard).getByText("decision")).toBeTruthy();
    expect(within(detailCard).getByText("pass")).toBeTruthy();

    // 日志按钮（antd 两汉字按钮自动插空格）→ Modal 展示全文
    await user.click(
      within(detailCard).getByRole("button", { name: /日\s*志/ }),
    );
    expect(await screen.findByText("line1", { exact: false })).toBeTruthy();
  });
});
