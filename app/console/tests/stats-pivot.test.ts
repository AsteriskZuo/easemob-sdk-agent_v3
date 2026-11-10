import {
  collectBizColumns,
  collectErrorDetails,
  eachDate,
  formatBizCell,
  formatCost,
  formatDurationMs,
  formatThousands,
  pivotDaily,
  type StatsRow,
} from "../src/stats";

/** 造一行长表数据（bucket 缺省 ""） */
function row(
  date: string,
  metric: string,
  value: number,
  bucket = "",
): StatsRow {
  return { date, metric, bucket, value };
}

describe("eachDate", () => {
  it("闭区间逐日展开（含跨月）", () => {
    expect(eachDate("2026-10-30", "2026-11-02")).toEqual([
      "2026-10-30",
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("单日区间", () => {
    expect(eachDate("2026-11-10", "2026-11-10")).toEqual(["2026-11-10"]);
  });
});

describe("pivotDaily", () => {
  it("长表透视：run/llm 指标映射到对应列，date 倒序", () => {
    const rows: StatsRow[] = [
      row("2026-11-09", "run.total", 3),
      row("2026-11-09", "run.success", 2),
      row("2026-11-09", "run.failed", 1),
      row("2026-11-09", "run.timeout", 0),
      row("2026-11-09", "run.failed_phase", 1, "main"),
      row("2026-11-09", "run.avg_duration_ms", 1500),
      row("2026-11-09", "llm.calls", 4),
      row("2026-11-09", "llm.tokens.input", 12345),
      row("2026-11-09", "llm.tokens.output", 678),
      row("2026-11-09", "llm.tokens.cache_read", 100),
      row("2026-11-09", "llm.tokens.cache_write", 20),
      row("2026-11-09", "llm.cost", 0.123456),
      row("2026-11-09", "llm.avg_duration_ms", 2345),
      row("2026-11-09", "llm.calls_without_usage", 1),
      row("2026-11-10", "run.total", 1),
      row("2026-11-10", "run.success", 1),
    ];
    const days = pivotDaily(rows, "2026-11-09", "2026-11-10");
    expect(days.map((d) => d.date)).toEqual(["2026-11-10", "2026-11-09"]);
    const d9 = days[1];
    expect(d9.run_total).toBe(3);
    expect(d9.run_failed_phase.main).toBe(1);
    expect(d9.run_failed_phase["check-input"]).toBe(0);
    expect(d9.run_avg_duration_ms).toBe(1500);
    expect(d9.llm_calls).toBe(4);
    expect(d9.llm_tokens_input).toBe(12345);
    expect(d9.llm_cost).toBeCloseTo(0.123456);
    expect(d9.llm_avg_duration_ms).toBe(2345);
    expect(d9.llm_calls_without_usage).toBe(1);
    // 11-10 只有部分行：缺失计数补 0，缺失 avg 为 null
    const d10 = days[0];
    expect(d10.run_total).toBe(1);
    expect(d10.llm_calls).toBe(0);
    expect(d10.run_avg_duration_ms).toBeNull();
    expect(d10.llm_avg_duration_ms).toBeNull();
  });

  it("零数据日补零行（区间内无行的日期出零值行）", () => {
    const days = pivotDaily([], "2026-11-08", "2026-11-10");
    expect(days.map((d) => d.date)).toEqual([
      "2026-11-10",
      "2026-11-09",
      "2026-11-08",
    ]);
    for (const d of days) {
      expect(d.run_total).toBe(0);
      expect(d.llm_calls).toBe(0);
      expect(d.llm_cost).toBe(0);
      expect(d.run_avg_duration_ms).toBeNull();
      expect(d.run_failed_phase.unknown).toBe(0);
    }
  });

  it("区间外的行不进结果", () => {
    const rows = [row("2026-11-05", "run.total", 9)];
    const days = pivotDaily(rows, "2026-11-09", "2026-11-10");
    expect(days.every((d) => d.run_total === 0)).toBe(true);
  });

  it("llm.errors / 未知指标不进主表固定列；biz.* 进 biz_text 供业务列组", () => {
    const rows: StatsRow[] = [
      row("2026-11-10", "llm.errors", 2, "agent_failed"),
      row("2026-11-10", "biz.decision", 5, "pass"),
      row("2026-11-10", "run.future_metric", 7),
    ];
    const days = pivotDaily(rows, "2026-11-10", "2026-11-10");
    expect(days[0].run_total).toBe(0);
    expect(days[0].llm_calls).toBe(0);
    expect(Object.keys(days[0])).not.toContain("llm_errors");
    expect(days[0].biz_text).toEqual({ decision: { pass: 5 } });
  });

  it("failed_phase 契约外桶名忽略（不炸列）", () => {
    const rows = [row("2026-11-10", "run.failed_phase", 3, "mystery")];
    const days = pivotDaily(rows, "2026-11-10", "2026-11-10");
    expect(days[0].run_failed_phase).toEqual({
      "check-input": 0,
      main: 0,
      "check-output": 0,
      unknown: 0,
    });
  });
});

describe("collectBizColumns", () => {
  it("无 biz 行返回空数组（「业务」列组整体不出现）", () => {
    const rows: StatsRow[] = [
      row("2026-11-10", "run.total", 1),
      row("2026-11-10", "llm.calls", 2),
      row("2026-11-10", "llm.errors", 1, "agent_failed"),
    ];
    expect(collectBizColumns(rows)).toEqual([]);
  });

  it("字符串指标：动态收集 (key,bucket) 并集，key 字典序 + bucket 字典序", () => {
    const rows: StatsRow[] = [
      row("2026-11-09", "biz.decision", 1, "reject"),
      row("2026-11-10", "biz.decision", 2, "pass"),
      row("2026-11-10", "biz.decision", 1, "pass"), // 同桶多日：去重
      row("2026-11-10", "biz.classification", 3, "bug"),
      row("2026-11-10", "biz.decision", 1, "abstain"),
    ];
    expect(collectBizColumns(rows).map((c) => c.id)).toEqual([
      "classification=bug",
      "decision=abstain",
      "decision=pass",
      "decision=reject",
    ]);
  });

  it("数值指标：每 key 固定 sum/avg/count 三列，与字符串 key 混排按 key 字典序", () => {
    const rows: StatsRow[] = [
      row("2026-11-10", "biz.score.count", 9),
      row("2026-11-10", "biz.score.avg", 3.5),
      row("2026-11-10", "biz.score.sum", 31.5),
      row("2026-11-10", "biz.decision", 1, "pass"),
    ];
    expect(collectBizColumns(rows).map((c) => c.id)).toEqual([
      "decision=pass",
      "score.sum",
      "score.avg",
      "score.count",
    ]);
  });

  it("同 key 混型防御：字符串桶列在前、数值三列在后", () => {
    const rows: StatsRow[] = [
      row("2026-11-10", "biz.mixed.sum", 10),
      row("2026-11-10", "biz.mixed", 1, "x"),
    ];
    expect(collectBizColumns(rows).map((c) => c.id)).toEqual([
      "mixed=x",
      "mixed.sum",
      "mixed.avg",
      "mixed.count",
    ]);
  });
});

describe("pivotDaily biz 族", () => {
  it("字符串指标进 biz_text、数值三行进 biz_num；缺失日无该键（不补零）", () => {
    const rows: StatsRow[] = [
      row("2026-11-10", "biz.decision", 7, "pass"),
      row("2026-11-10", "biz.decision", 2, "reject"),
      row("2026-11-10", "biz.score.sum", 30),
      row("2026-11-10", "biz.score.avg", 3.14159),
      row("2026-11-10", "biz.score.count", 9),
    ];
    const days = pivotDaily(rows, "2026-11-09", "2026-11-10");
    const [d10, d9] = days;
    expect(d10.biz_text).toEqual({ decision: { pass: 7, reject: 2 } });
    expect(d10.biz_num).toEqual({
      score: { sum: 30, avg: 3.14159, count: 9 },
    });
    // 11-09 无 biz 行：空表（列存在时单元格渲染 -）
    expect(d9.biz_text).toEqual({});
    expect(d9.biz_num).toEqual({});
  });

  it("与 run.*/llm.* 混排不互相干扰", () => {
    const rows: StatsRow[] = [
      row("2026-11-10", "run.total", 3),
      row("2026-11-10", "llm.calls", 4),
      row("2026-11-10", "biz.decision", 5, "pass"),
      row("2026-11-10", "biz.score.sum", 42),
    ];
    const days = pivotDaily(rows, "2026-11-10", "2026-11-10");
    expect(days[0].run_total).toBe(3);
    expect(days[0].llm_calls).toBe(4);
    expect(days[0].biz_text.decision).toEqual({ pass: 5 });
    expect(days[0].biz_num.score?.sum).toBe(42);
    // biz 行不产生 run/llm 固定列的假数据，run/llm 行也不进 biz
    expect(collectBizColumns(rows).map((c) => c.id)).toEqual([
      "decision=pass",
      "score.sum",
      "score.avg",
      "score.count",
    ]);
    expect(days[0].biz_text.run).toBeUndefined();
  });
});

describe("collectErrorDetails", () => {
  it("提取 llm.errors：date 倒序 + 错误码字典序", () => {
    const rows: StatsRow[] = [
      row("2026-11-09", "llm.errors", 1, "agent_failed"),
      row("2026-11-10", "llm.errors", 2, "model_not_allowed"),
      row("2026-11-10", "llm.errors", 3, "agent_failed"),
      row("2026-11-10", "llm.calls", 5),
    ];
    expect(collectErrorDetails(rows)).toEqual([
      { date: "2026-11-10", error: "agent_failed", count: 3 },
      { date: "2026-11-10", error: "model_not_allowed", count: 2 },
      { date: "2026-11-09", error: "agent_failed", count: 1 },
    ]);
  });

  it("无错误行返回空数组", () => {
    expect(collectErrorDetails([row("2026-11-10", "llm.calls", 5)])).toEqual(
      [],
    );
  });
});

describe("格式化", () => {
  it("千分位", () => {
    expect(formatThousands(0)).toBe("0");
    expect(formatThousands(999)).toBe("999");
    expect(formatThousands(1234567)).toBe("1,234,567");
  });

  it("耗时 ms → s（1 位小数）；null 显示 -", () => {
    expect(formatDurationMs(1500)).toBe("1.5 s");
    expect(formatDurationMs(2345)).toBe("2.3 s");
    expect(formatDurationMs(null)).toBe("-");
  });

  it("成本 $ + 4 位小数；null 显示 -", () => {
    expect(formatCost(0.123456)).toBe("$0.1235");
    expect(formatCost(0)).toBe("$0.0000");
    expect(formatCost(null)).toBe("-");
  });

  it("业务单元格：count 千分位、sum 整数千分位/小数 2 位、avg 2 位、缺失 -", () => {
    expect(formatBizCell(1234, "count")).toBe("1,234");
    expect(formatBizCell(1234, "sum")).toBe("1,234");
    expect(formatBizCell(31.5, "sum")).toBe("31.50");
    expect(formatBizCell(3.14159, "avg")).toBe("3.14");
    expect(formatBizCell(3, "avg")).toBe("3.00");
    expect(formatBizCell(undefined, "count")).toBe("-");
    expect(formatBizCell(undefined, "sum")).toBe("-");
    expect(formatBizCell(undefined, "avg")).toBe("-");
  });
});
