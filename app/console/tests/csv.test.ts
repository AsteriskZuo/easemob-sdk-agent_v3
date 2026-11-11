import {
  buildStatsCsv,
  escapeCsvField,
  statsCsvFileName,
} from "../src/csv";
import { collectBizColumns, pivotDaily, type StatsRow } from "../src/stats";

const FROM = "2026-11-01";
const TO = "2026-11-02";

function fixtureRows(): StatsRow[] {
  const row = (
    date: string,
    metric: string,
    value: number,
    bucket = "",
  ): StatsRow => ({ date, metric, bucket, value });
  return [
    row(TO, "run.total", 3),
    row(TO, "run.success", 2),
    row(TO, "run.failed", 1),
    row(TO, "run.failed_phase", 1, "main"),
    row(TO, "run.avg_duration_ms", 1500),
    row(TO, "llm.calls", 4),
    row(TO, "llm.tokens.input", 12345),
    row(TO, "llm.cost", 0.123456),
    row(TO, "biz.decision", 7, "pass"),
    row(TO, "biz.note", 2, '含,逗"号\n换行'),
  ];
}

describe("escapeCsvField", () => {
  it("普通字段原样；含 , \" \\n 的字段 RFC4180 引号转义", () => {
    expect(escapeCsvField("abc")).toBe("abc");
    expect(escapeCsvField("a,b")).toBe('"a,b"');
    expect(escapeCsvField('a"b')).toBe('"a""b"');
    expect(escapeCsvField("a\nb")).toBe('"a\nb"');
    expect(escapeCsvField("a\rb")).toBe('"a\rb"');
  });
});

describe("buildStatsCsv", () => {
  it("BOM + 中文列头（列组拼父-子，含动态 biz 列）+ 透视值 + CRLF", () => {
    const rows = fixtureRows();
    const csv = buildStatsCsv(
      pivotDaily(rows, FROM, TO),
      collectBizColumns(rows),
    );
    expect(csv.startsWith("\uFEFF")).toBe(true);

    const lines = csv.slice(1).split("\r\n");
    expect(lines[lines.length - 1]).toBe(""); // 末行 CRLF 收尾
    const header = lines[0];
    expect(header).toContain("日期,运行-总数,运行-成功,运行-失败,运行-超时");
    expect(header).toContain("运行-失败-输入校验,运行-失败-主流程");
    expect(header).toContain("大模型-调用次,大模型-输入 token");
    expect(header).toContain("大模型-成本,大模型-平均耗时,大模型-无用量次");
    expect(header).toContain("业务-decision=pass");
    // biz 桶值含 , " \n：列头整字段加引号、引号双写
    expect(header).toContain('"业务-note=含,逗""号\n换行"');

    // 数据行：TO 倒序在前（有数据），FROM 零值行在后
    expect(lines).toHaveLength(1 + 2 + 1);
    expect(lines[1]).toContain(`${TO},3,2,1,0,0,1,0,0,1.5 s,4,"12,345"`);
    expect(lines[1]).toContain("$0.1235");
    expect(lines[1]).toContain(",7,2");
    // 零数据日：计数补 0、平均耗时 -
    expect(lines[2]).toContain(`${FROM},0,0,0,0,0,0,0,0,-,0,0`);
  });

  it("无 biz 列时不出业务列头", () => {
    const rows = fixtureRows().filter((r) => !r.metric.startsWith("biz."));
    const csv = buildStatsCsv(pivotDaily(rows, FROM, TO), []);
    expect(csv).not.toContain("业务-");
  });
});

describe("statsCsvFileName", () => {
  it("stats-{business_id}-{from}-{to}.csv", () => {
    expect(statsCsvFileName("biz-1", FROM, TO)).toBe(
      "stats-biz-1-2026-11-01-2026-11-02.csv",
    );
  });
});
