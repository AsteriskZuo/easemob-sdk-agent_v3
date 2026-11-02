import { App as AntdApp, Button, Drawer, Tabs, Typography } from "antd";
import { useState } from "react";
import { EFFECTIVENESS_NOTE } from "./EffectivenessNote";

/** 单个厂商的帮助内容：模板原文只保证与当前锁定 Pi 的结构起点一致，
 *  用户仍需按账号、区域和厂商文档修改并真实验证（保存前每个列出的模型都会被逐个真实探针调用） */
interface ProviderHelp {
  /** Tab 展示名 */
  label: string;
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
    note: "自定义 DashScope provider，显式声明模型（必填）；contextWindow/maxTokens 是保守控制值，不宣称厂商上限。可按需在 models 数组里追加更多模型。",
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
    note: "使用 Pi 内置 provider：只给 apiKey 并显式列出要用的模型 id（与内置目录同名即自动继承其元数据；models 是必填的，不写将无法保存）。内置目录当前含 deepseek-flash、deepseek-v4-pro。",
    template: `{
  "providers": {
    "deepseek": {
      "apiKey": "sk-your-deepseek-key",
      "models": [
        { "id": "deepseek-flash" },
        { "id": "deepseek-v4-pro" }
      ]
    }
  }
}`,
    docUrl: "https://api-docs.deepseek.com/",
  },
  {
    label: "OpenAI",
    note: "使用 Pi 内置 provider：只给 apiKey 并显式列出要用的模型 id（同名继承内置元数据；models 必填）。按账号实际可用模型修改——写出的每个模型保存前都会被真实验证。",
    template: `{
  "providers": {
    "openai": {
      "apiKey": "sk-your-openai-key",
      "models": [
        { "id": "gpt-4o" },
        { "id": "gpt-4.1-mini" }
      ]
    }
  }
}`,
    docUrl: "https://platform.openai.com/docs/api-reference",
  },
  {
    label: "本地（Ollama）",
    note: "自建 provider 指向本地 Ollama 的 OpenAI 兼容端点；apiKey 必填但 Ollama 不校验（占位即可）。本地模型冷启动可能较慢，验证探针单模型最长 30 秒，请先用 ollama run 预热。",
    template: `{
  "providers": {
    "ollama": {
      "baseUrl": "http://127.0.0.1:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "qwen3:8b" }
      ]
    }
  }
}`,
    docUrl: "https://github.com/ollama/ollama/blob/main/docs/openai.md",
  },
];

/** 厂商帮助抽屉（问号触发）：分厂商标签，提供复制模板与官方文档链接。
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
        编辑器后按账号、区域和厂商文档修改。两点须知：① 默认模型 = 第一个
        provider 的第一个模型（sdk.agent 不传 model 时使用），
        请把主用模型排在最前；②
        列出的每个模型保存前都会被逐个真实验证，验证不过的必须从配置中移除，全部通过才能保存。
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
