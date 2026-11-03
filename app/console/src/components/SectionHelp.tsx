import { useState } from "react";
import { Button, Drawer, Tooltip } from "antd";
import { QuestionCircleOutlined, ReadOutlined } from "@ant-design/icons";

/** 三态提示约定（console 内容规范）：
 *  ① 小字提示 = 区块/字段旁的 extra 灰色小字（一行操作引导，组件不管，由调用方写）；
 *  ② 短提示 tip = 标题旁 ? 图标 hover（「是什么/何时用/配错后果」三段式，一两句话）；
 *  ③ 抽屉 drawer = 标题旁 📖 按钮弹右侧抽屉（长文知识点：概念、机制、示例）。
 *  本组件统一承载 ②③；内容暂为静态文案，后续由 handbook 文档体系（generated json）供给。 */
export interface SectionHelpProps {
  /** 区块标题 */
  title: string;
  /** 短提示（Tooltip 内容，三段式：是什么/何时用/配错后果） */
  tip?: string;
  /** 抽屉长文（markdown 原文，pre-wrap 展示不引渲染器） */
  drawerDoc?: string;
  /** 抽屉标题（缺省 = `${title} · 说明`） */
  drawerTitle?: string;
}

/** 区块标题 + 短提示 + 抽屉入口的组合头。抽屉按钮仅在给了 drawerDoc 时渲染。 */
export default function SectionHelp({
  title,
  tip,
  drawerDoc,
  drawerTitle,
}: SectionHelpProps) {
  const [open, setOpen] = useState(false);
  return (
    <span>
      {title}
      {tip !== undefined && tip !== "" && (
        <Tooltip title={tip}>
          <QuestionCircleOutlined style={{ marginLeft: 8, color: "#999" }} />
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
