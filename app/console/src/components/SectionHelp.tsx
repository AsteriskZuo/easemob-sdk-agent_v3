import { useState } from "react";
import { Button, Drawer, Tooltip } from "antd";
import { QuestionCircleOutlined, ReadOutlined } from "@ant-design/icons";
import type { HandbookPage } from "@asteriskzuo/agent-console-api";
import { handbookBody, handbookTitle } from "../handbook";

/** 三态提示约定（console 内容规范）：
 *  ① 小字提示 = 区块/字段旁的 extra 灰色小字（一行操作引导，组件不管，由调用方写）；
 *  ② 短提示 tip = 标题旁 ? 图标 hover（「是什么/何时用/配错后果」三段式，一两句话）；
 *  ③ 抽屉 drawer = 标题旁 📖 按钮弹右侧抽屉（长文知识点：概念、机制、示例）。
 *  ②③ 的内容统一按 handbook 条目 id 从 generated JSON 经 console-api 获取。 */
export interface SectionHelpProps {
  /** 区块标题（UI 结构信息，留在代码） */
  title: string;
  /** 当前页面的 handbook 条目集合 */
  entries: HandbookPage;
  /** 短提示条目 id */
  tipId?: string;
  /** 抽屉长文条目 id */
  drawerId?: string;
}

/** 区块标题 + 短提示 + 抽屉入口的组合头。文档未加载或条目非 stable 时不显示空按钮。 */
export default function SectionHelp({
  title,
  entries,
  tipId,
  drawerId,
}: SectionHelpProps) {
  const [open, setOpen] = useState(false);
  const tip = tipId === undefined ? undefined : handbookBody(entries, tipId);
  const drawerDoc =
    drawerId === undefined ? undefined : handbookBody(entries, drawerId);
  const drawerTitle =
    drawerId === undefined ? undefined : handbookTitle(entries, drawerId);
  return (
    <span>
      {title}
      {tip !== undefined && tip !== "" && (
        <Tooltip title={tip}>
          <QuestionCircleOutlined
            aria-label={`${title} 短提示`}
            style={{ marginLeft: 8, color: "#999" }}
          />
        </Tooltip>
      )}
      {drawerDoc !== undefined && drawerDoc !== "" && (
        <>
          <Button
            type="text"
            size="small"
            aria-label={`${title} 详细说明`}
            icon={<ReadOutlined />}
            style={{ marginLeft: 4, color: "#999" }}
            onClick={() => setOpen(true)}
          />
          <Drawer
            title={drawerTitle ?? `${title} · 说明`}
            placement="right"
            width={520}
            open={open}
            onClose={() => setOpen(false)}
          >
            <pre
              style={{
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontSize: 13,
                lineHeight: 1.7,
                fontFamily: "inherit",
              }}
            >
              {drawerDoc}
            </pre>
          </Drawer>
        </>
      )}
    </span>
  );
}
