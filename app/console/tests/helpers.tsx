import { configure, render, screen } from "@testing-library/react";
import userEvent, {
  PointerEventsCheckLevel,
} from "@testing-library/user-event";
import { App as AntdApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { MemoryRouter } from "react-router-dom";
import type { User } from "@asterisk/agent-console-api";
import App from "../src/App";
import { AuthProvider } from "../src/auth/AuthContext";

/** 测试用户 fixture */
export const ADMIN_USER: User = {
  user_id: "usr_admin",
  username: "root",
  display_name: "管理员",
  role: "admin",
  disabled: false,
  created_at: "2026-01-01T00:00:00.000Z",
};

export const MEMBER_USER: User = {
  user_id: "usr_member1",
  username: "alice",
  display_name: "爱丽丝",
  role: "member",
  disabled: false,
  created_at: "2026-01-01T00:00:00.000Z",
};

/** 一次被 mock 的 fetch 调用（body 已反序列化） */
export interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** handler 返回值：status + JSON body（body undefined = 无体） */
export interface MockResult {
  status: number;
  body?: unknown;
}

export type MockHandler = (
  path: string,
  init: { method: string; body?: string },
) => MockResult | undefined;

/** 安装 fetch stub 并返回调用记录。handler 未覆盖的请求返回 500 internal（防漏配静默通过） */
export function installFetchMock(handler: MockHandler): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const fakeFetch = async (
    input: unknown,
    init?: { method?: string; body?: string; headers?: Record<string, string> },
  ): Promise<Response> => {
    const path = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path,
      body: init?.body !== undefined ? JSON.parse(init.body) : undefined,
      ...(init?.headers !== undefined ? { headers: init.headers } : {}),
    });
    const result = handler(path, { method, body: init?.body });
    const status = result?.status ?? 500;
    const payload =
      result?.body !== undefined
        ? result.body
        : status >= 400
          ? {
              error: {
                code: "internal",
                message: `未 mock: ${method} ${path}`,
              },
            }
          : undefined;
    return {
      status,
      ok: status >= 200 && status < 300,
      text: () =>
        Promise.resolve(payload === undefined ? "" : JSON.stringify(payload)),
    } as Response;
  };
  (globalThis as { fetch: unknown }).fetch = fakeFetch;
  return calls;
}

/** 以真实 App 渲染（ConfigProvider zhCN + AntdApp + MemoryRouter + AuthProvider，与 main.tsx 同构） */
// 注意：configure 必须在本模块（被打包进每个测试 bundle，与测试共享同一份
// @testing-library/dom）；放 setup.ts 里是另一份副本，配置不生效。
// antd 大 DOM 下 findBy* 默认 1s 不够，放宽到 8s
configure({ asyncUtilTimeout: 8000 });

export function renderApp(initialPath: string) {
  return render(
    <ConfigProvider locale={zhCN}>
      <AntdApp>
        <MemoryRouter initialEntries={[initialPath]}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>
      </AntdApp>
    </ConfigProvider>,
  );
}

/** 统一 userEvent 配置：跳过 pointer-events 可见性检查。
 *  antd cssinjs 往 <style> 注入全量 CSS，jsdom 的 getComputedStyle 每次都要重解析，
 *  该检查会让每次点击/按键花掉数秒（测试环境无真实渲染，此检查无意义） */
export function setupUser(): ReturnType<typeof userEvent.setup> {
  return userEvent.setup({
    pointerEventsCheck: PointerEventsCheckLevel.Never,
  });
}

/** 选 antd Select 项：点开 combobox 下拉后点击可见选项
 * （绕开 rc-select 的 aria-hidden 无障碍副本——副本同样含选项文本；
 *  antd 会把 aria-label 同时放到 Select 根 div 和内部 input 上，取 input 点击） */
export async function selectOption(
  user: ReturnType<typeof userEvent.setup>,
  comboboxLabel: string,
  optionText: string,
): Promise<void> {
  const candidates = screen.getAllByLabelText(comboboxLabel);
  const combobox =
    candidates.find((el) => el.tagName === "INPUT") ?? candidates[0];
  await user.click(combobox);
  const options = await screen.findAllByText(optionText);
  const visible = options.find(
    (el) =>
      el.closest('[aria-hidden="true"]') === null &&
      el.closest(".ant-select-item-option") !== null,
  );
  if (visible === undefined) {
    throw new Error(`下拉选项未找到: ${comboboxLabel} → ${optionText}`);
  }
  await user.click(visible);
}
