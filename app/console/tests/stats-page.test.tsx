import { screen } from "@testing-library/react";
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
});
