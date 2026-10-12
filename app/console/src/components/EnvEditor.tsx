import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import { App as AntdApp, Button } from "antd";
import type { EnvListView } from "@asteriskzuo/agent-console-api";
import { apiFetch, ApiError } from "../api/client";
import { KvGroup } from "./CreateEnvEditor";
import type { EnvKvRow } from "./CreateEnvEditor";

export interface EnvEditorProps {
  /** 通用层（global）或业务层（business） */
  scope: "global" | "business";
  /** scope=business 时必填（业务 id） */
  businessId?: string;
  /** true = 只读（如 member 看通用层）：隐藏全部编辑入口 */
  readOnly?: boolean;
  /** true = 隐藏本组件的保存/重置按钮（由外层统一保存，经 ref.save() 触发） */
  hideActions?: boolean;
}

export interface EnvEditorHandle {
  /** 保存两组草稿（逐 key PUT/DELETE diff）；无改动 = 静默成功返回 true。
   *  任一失败：内部已报错 + reload 回服务端状态，返回 false */
  save(): Promise<boolean>;
  /** 放弃草稿，恢复为服务端状态 */
  reload(): Promise<void>;
}

/** 两桶 key-value 编辑器：与创建页同一套行内编辑（KvGroup），草稿 + 保存语义——
 *  行内增删改先入草稿，「保存」对后端做逐 key PUT/DELETE diff（API 不变）。
 *  自管理读写；hideActions 时由外层表单统一保存（ref.save()），仍不并入同一请求。
 *  secrets 只写不读：已有键只回显键名，值留空 = 保持不变，填写 = 覆盖；
 *  删除行同样保存后才生效。 */
const EnvEditor = forwardRef<EnvEditorHandle, EnvEditorProps>(
  function EnvEditor({ scope, businessId, readOnly, hideActions }, ref) {
    const { message } = AntdApp.useApp();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    // 草稿行；originals 记录已保存状态供 diff（vars 需比对值，secrets 只比对键集合）
    const [varRows, setVarRows] = useState<EnvKvRow[]>([]);
    const [secretRows, setSecretRows] = useState<EnvKvRow[]>([]);
    const [originalVars, setOriginalVars] = useState<Record<string, string>>(
      {},
    );
    const [originalSecretKeys, setOriginalSecretKeys] = useState<string[]>([]);

    const basePath =
      scope === "global"
        ? "/api/env/global"
        : `/api/env/businesses/${businessId}`;

    const reload = useCallback(async () => {
      setLoading(true);
      try {
        const view = await apiFetch<EnvListView>(basePath);
        setOriginalVars(view.vars);
        setOriginalSecretKeys(view.secret_keys);
        setVarRows(
          Object.entries(view.vars).map(([key, value]) => ({ key, value })),
        );
        setSecretRows(view.secret_keys.map((key) => ({ key, value: "" })));
      } catch (err) {
        message.error(
          err instanceof ApiError ? err.message : "加载环境配置失败",
        );
      } finally {
        setLoading(false);
      }
      // basePath 由 scope/businessId 派生；message 实例稳定
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [basePath]);

    useEffect(() => {
      void reload();
    }, [reload]);

    /** 单组 diff → 操作序列（键空白的行丢弃） */
    const buildOps = useCallback(
      (
        bucket: "vars" | "secrets",
        rows: EnvKvRow[],
      ): Array<{
        method: "PUT" | "DELETE";
        bucket: string;
        key: string;
        value?: string;
      }> => {
        const kept = rows.filter((row) => row.key.trim() !== "");
        const ops: Array<{
          method: "PUT" | "DELETE";
          bucket: string;
          key: string;
          value?: string;
        }> = [];
        for (const row of kept) {
          if (bucket === "secrets") {
            // 值留空 = 保持不变（已有键）或忽略（新键）；非空 = 写入/覆盖
            if (row.value !== "") {
              ops.push({
                method: "PUT",
                bucket,
                key: row.key,
                value: row.value,
              });
            }
          } else if (
            !(row.key in originalVars) ||
            originalVars[row.key] !== row.value
          ) {
            ops.push({ method: "PUT", bucket, key: row.key, value: row.value });
          }
        }
        const keptKeys = new Set(kept.map((row) => row.key));
        const originals =
          bucket === "vars" ? Object.keys(originalVars) : originalSecretKeys;
        for (const key of originals) {
          if (!keptKeys.has(key)) ops.push({ method: "DELETE", bucket, key });
        }
        return ops;
      },
      [originalVars, originalSecretKeys],
    );

    /** 保存两组草稿。silentSuccess：由外层统一提示时静默 */
    const save = useCallback(
      async (silentSuccess = false): Promise<boolean> => {
        const ops = [
          ...buildOps("vars", varRows),
          ...buildOps("secrets", secretRows),
        ];
        if (ops.length === 0) return true;
        setSaving(true);
        try {
          for (const op of ops) {
            await apiFetch<void>(basePath, {
              method: op.method,
              body: { bucket: op.bucket, key: op.key, value: op.value },
            });
          }
          if (!silentSuccess) message.success("环境配置已保存");
          await reload();
          return true;
        } catch (err) {
          message.error(
            `环境配置保存失败：${err instanceof ApiError ? err.message : "未知错误"}`,
          );
          await reload();
          return false;
        } finally {
          setSaving(false);
        }
      },
      [basePath, varRows, secretRows, buildOps, reload, message],
    );

    useImperativeHandle(ref, () => ({ save: () => save(true), reload }), [
      save,
      reload,
    ]);

    const actions =
      readOnly || hideActions ? null : (
        <div style={{ marginBottom: 16 }}>
          <Button
            size="small"
            type="primary"
            loading={saving}
            disabled={loading}
            onClick={() => void save()}
          >
            保存
          </Button>
          <Button
            size="small"
            style={{ marginLeft: 8 }}
            disabled={loading || saving}
            onClick={() => void reload()}
          >
            重置
          </Button>
        </div>
      );

    return (
      <div>
        <KvGroup
          groupLabel="vars"
          title="普通配置（vars）"
          tip="明文键值对，业务运行时注入为环境变量。行内增删改先入草稿，「保存」后生效（含删除）；「重置」恢复为已保存状态。改了立即生效于后续 run；配错键名业务会取不到值。"
          rows={varRows}
          secret={false}
          onChange={setVarRows}
          readOnly={readOnly || loading}
        />
        <KvGroup
          groupLabel="secrets"
          title="安全配置（secrets）"
          tip="机密键值（令牌、凭据），只写不读：已有键只回显键名——值留空 = 保持不变，填写 = 覆盖；删除行同样「保存」后生效。"
          rows={secretRows}
          secret={true}
          onChange={setSecretRows}
          valuePlaceholder="留空 = 保持不变；填写 = 覆盖"
          readOnly={readOnly || loading}
        />
        {actions}
      </div>
    );
  },
);

export default EnvEditor;
