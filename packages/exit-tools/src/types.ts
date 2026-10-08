/** 配置项声明：控制台据此渲染表单；secret=true 的项不存入绑定配置，
 *  由控制台写入 EnvProvider、装配根 bind 前合并注入 */
export interface ConfigField {
  key: string; // 配置键（bind 收到的 config 里的键名）
  label: string; // 展示名（控制台表单 label）
  required?: boolean; // 缺省 false；true 时 bind 校验缺失即抛错
  secret?: boolean; // 缺省 false；true = 机密项（不落库进绑定、不进日志）
  placeholder?: string; // 表单占位提示
}

/** 出口工具：内置投递器菜单的一项 */
export interface ExitTool {
  readonly kind: string; // 标识，全平台唯一（如 'wecom-webhook'）
  readonly name: string; // 展示名（如「企业微信群机器人」），控制台按它选用
  readonly implemented: boolean; // false = 占位（菜单可见但不可实际投递；控制台据此置灰/标记）
  readonly configSchema: ConfigField[]; // 配置项声明，控制台据此渲染表单；占位工具为空数组（待定）
  /** markdown：业务侧 sdk.return 该返回什么形状 + 示例 JSON（控制台出口区「看了就懂」的对接依据；
   *  内容须与本工具 deliver 的实际消费逻辑一致）。通用约定：sdk.return(null) = 无产出不投递，
   *  各工具文档不再重复此条 */
  readonly resultDoc: string;

  /** 投递目标标识：从非机密配置提取——出口 channel_id 的第二维。
   *  必须文件路径安全；配置缺失/非法抛错（该绑定将被调度循环判失败）。
   *  占位工具调用即抛「未实现」 */
  destinationOf(config: Record<string, string>): string;

  /** 用完整配置（含已合并的机密项）实例化出口；required 项缺失即抛错。
   *  配置由实例持有，deliver 不再传。占位工具调用即抛「未实现」 */
  bind(config: Record<string, string>): Exit;
}

/** 出口实例：已持有配置 */
export interface Exit {
  /** 投递业务产出（派生事件的 payload 原样）。成功返回；失败（网络/对端拒绝/超时）抛错 */
  deliver(result: unknown): Promise<void>;
}

/** 出口工具注册表：内置菜单的登记与取用 */
export interface ExitRegistry {
  /** 按 kind 取工具；未注册抛错 */
  get(kind: string): ExitTool;
  /** 全部内置工具（含占位），控制台菜单 */
  list(): ExitTool[];
}
