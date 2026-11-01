import { Typography } from "antd";

/** 统一生效说明（spec §10.2）：所有经统一更新队列的管理写入共用同一条文案。
 *  页面一律不展示 pending / update_id / 进度等队列状态，只用这条文案说明生效时机 */
export const EFFECTIVENESS_NOTE =
  "当前有任务执行时，修改将在受影响业务空闲后自动生效，后续运行使用新配置；生效前页面显示当前生效值。";

/** 生效说明行（次要文字样式，放在各管理操作入口附近） */
export default function EffectivenessNote() {
  return (
    <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
      {EFFECTIVENESS_NOTE}
    </Typography.Paragraph>
  );
}
