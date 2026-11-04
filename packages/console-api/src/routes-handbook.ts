import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ApiError } from "./errors.js";
import type { HandbookPage } from "./dto.js";
import { sendJson } from "./http.js";
import type { Route } from "./router.js";

/** src/dist 到仓库根向上三级；编译测试多一层 dist-test/src，因此增加四级候选。 */
const HANDBOOK_DIR_CANDIDATES = [
  "../../../handbook/generated/console/",
  "../../../../handbook/generated/console/",
].map((path) => fileURLToPath(new URL(path, import.meta.url)));
const CONSOLE_HANDBOOK_DIR =
  HANDBOOK_DIR_CANDIDATES.find((path) => existsSync(path)) ??
  HANDBOOK_DIR_CANDIDATES[0];
const PAGE_PATTERN = /^[a-z0-9-]+$/;

/** handbook 控制台说明：直接读取生成物，源内容更新并重新生成后无需重启 API。 */
export function handbookRoutes(): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/handbook/:page",
      handler: async (req, res) => {
        const page = req.params.page;
        if (!PAGE_PATTERN.test(page)) {
          throw new ApiError("not_found", "说明文档页面不存在");
        }
        let text: string;
        try {
          text = await readFile(`${CONSOLE_HANDBOOK_DIR}${page}.json`, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new ApiError("not_found", `说明文档页面不存在: ${page}`);
          }
          throw error;
        }
        const entries = JSON.parse(text) as HandbookPage;
        sendJson(res, 200, entries);
      },
    },
  ];
}
