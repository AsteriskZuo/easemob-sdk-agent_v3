import { App as AntdApp, Button, Drawer, Tabs, Typography } from "antd";
import { useState } from "react";
import { EFFECTIVENESS_NOTE } from "./EffectivenessNote";

/** 单个厂商的帮助内容：模板原文与 spec §10.3 保持一致（只保证与当前锁定 Pi 的结构起点一致，
 *  用户仍需按账号、区域和厂商文档修改并真实验证；baseUrl 是 API 根，不追加端点路径） */
interface ProviderHelp {
  /** Tab 展示名 */
  label: string;
  /** 模型选择示例（provider/id） */
  modelExample: string;
  /** 模板说明（为什么这样写） */
  note: string;
  /** models.json 模板原文（复制用） */
  template: string;
  /** 官方文档入口 */
  docUrl: string;
}

const PROVIDERS: ProviderHelp[] = [
  {
    label: "千问（DashScope）",
    modelExample: "dashscope/qwen-plus",
    note: "自定义 DashScope provider，显式声明模型；contextWindow/maxTokens 是保守控制值，不宣称厂商上限。",
    template: `{
  "providers": {
    "dashscope": {
      "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "api": "openai-completions",
      "apiKey": "sk-your-dashscope-key",
      "models": [
        {
          "id": "qwen-plus",
          "name": "Qwen Plus",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  }
}`,
    docUrl: "https://help.aliyun.com/zh/model-studio/",
  },
  {
    label: "DeepSeek",
    modelExample: "deepseek/deepseek-flash",
    note: "使用 Pi 内置 provider，不重声明 models，以保留内置模型元数据。",
    template: `{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com",
      "api": "openai-completions",
      "apiKey": "sk-your-deepseek-key"
    }
  }
}`,
    docUrl: "https://api-docs.deepseek.com/",
  },
  {
    label: "OpenAI",
    modelExample: "openai/gpt-5.4",
    note: "使用 Pi 内置 provider，不重声明 models，以保留内置模型元数据。",
    template: `{
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "api": "openai-responses",
      "apiKey": "sk-your-openai-key"
    }
  }
}`,
    docUrl: "https://platform.openai.com/docs/api-reference",
  },
];

/** 厂商帮助抽屉（问号触发）：三个厂商分标签，提供复制模板与官方文档链接。
 *  纯静态帮助数据——不自动合并、不保存、不参与验证与运行判断 */
export default function PiProviderHelpDrawer({
  open,
  onClose,
}: {
  /** 抽屉开关 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [activeKey, setActiveKey] = useState("0");

  const copy = (text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => message.success("模板已复制"))
      .catch(() => message.error("复制失败，请手动选择文本复制"));
  };

  return (
    <Drawer
      title="厂商配置帮助"
      open={open}
      onClose={onClose}
      width={560}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        模板是填写的起点，不自动合并或保存：复制到左侧 JSON
        编辑器后按账号、区域和厂商文档修改，模型选择填「模型选择示例」所示的
        provider/id。保存前必须先在编辑页完成在线验证。
      </Typography.Paragraph>
      <Tabs
        activeKey={activeKey}
        onChange={setActiveKey}
        items={PROVIDERS.map((p, index) => ({
          key: String(index),
          label: p.label,
          children: (
            <div>
              <Typography.Paragraph>{p.note}</Typography.Paragraph>
              <Typography.Paragraph>
                模型选择示例：
                <Typography.Text code>{p.modelExample}</Typography.Text>
              </Typography.Paragraph>
              <pre
                style={{
                  background: "#f5f5f5",
                  padding: 12,
                  fontSize: 12,
                  overflow: "auto",
                }}
              >
                {p.template}
              </pre>
              <Button onClick={() => copy(p.template)}>复制模板</Button>
              <Typography.Paragraph style={{ marginTop: 12 }}>
                官方文档：
                <Typography.Link href={p.docUrl} target="_blank">
                  {p.docUrl}
                </Typography.Link>
              </Typography.Paragraph>
            </div>
          ),
        }))}
      />
      <Typography.Paragraph type="warning" style={{ marginTop: 16 }}>
        安全提示：apiKey 支持 `!command` 形式（Pi
        原生能力，由命令动态提供密钥）。该命令会以平台服务所在 OS
        用户的权限执行——在线验证阶段就会执行，并非只在正式运行时；请勿填写来源不可信的命令。
      </Typography.Paragraph>
      <Typography.Paragraph type="secondary">
        {EFFECTIVENESS_NOTE}
      </Typography.Paragraph>
    </Drawer>
  );
}
