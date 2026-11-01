/** 统一更新提交窄接口（由 app/server 的 UpdateCoordinator 实现并注入）。
 *  console-api 只组装命令与权限校验，不认识队列、屏障与应用处理器细节 */
export interface UpdateCommandInput {
  /** 命令类型（kind）；应用处理器归 app/server */
  kind: string;
  /** JSON 可序列化完整参数；可含 secret（队列明文落库，禁止进入日志） */
  payload: unknown;
  /** 空数组=创建或无引用资产；单业务为一项、共享资产为多个引用方；all=全业务屏障 */
  business_ids: string[] | "all";
  /** 已认证操作者 user_id（审计用） */
  requested_by: string;
}

/** 提交结果：applied=已等待应用完成（result 为处理器返回，路由据此保持既有同步响应）；
 *  accepted=已持久化但仍被活动执行阻塞（路由返回 202 { accepted: true }） */
export type UpdateSubmission<T> =
  | { update_id: string; outcome: "applied"; result: T }
  | { update_id: string; outcome: "accepted" };

export interface UpdateSubmitter {
  /** 立即应用失败时同步抛出处理器错误（路由按既有错误映射） */
  submit<T>(command: UpdateCommandInput): Promise<UpdateSubmission<T>>;
}
