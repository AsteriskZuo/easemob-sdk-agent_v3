import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetTestLogger, startTestServer } from "./helpers.js";
import type { TestServer } from "./helpers.js";

const INDEX_HTML = "<!doctype html><html><body>console</body></html>";
const JS_CONTENT = "console.log('bundle');";
const CSS_CONTENT = "body { margin: 0; }";

let server: TestServer | null = null;
let staticDir: string | null = null;

afterEach(async () => {
  if (server !== null) {
    await server.stop();
    server = null;
  }
  if (staticDir !== null) {
    rmSync(staticDir, { recursive: true, force: true });
    staticDir = null;
  }
});

afterAll(() => {
  resetTestLogger();
});

/** 造一份模拟 vite 产物目录（独立临时目录，不属于 server.tmpDir——stop 会清掉它） */
function makeStaticDir(options: { withIndex?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "console-static-test-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  if (options.withIndex !== false) {
    writeFileSync(join(dir, "index.html"), INDEX_HTML);
  }
  writeFileSync(join(dir, "assets", "index-B7k2mP9x.js"), JS_CONTENT);
  writeFileSync(join(dir, "assets", "style.css"), CSS_CONTENT);
  return dir;
}

describe("静态托管（static_dir）", () => {
  it("GET / 命中 index.html：内容、MIME、no-cache", async () => {
    staticDir = makeStaticDir();
    server = await startTestServer({ static_dir: staticDir });

    const res = await fetch(`${server.baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("命中带 hash 的静态资源：MIME 正确 + immutable 缓存", async () => {
    staticDir = makeStaticDir();
    server = await startTestServer({ static_dir: staticDir });

    const res = await fetch(`${server.baseUrl}/assets/index-B7k2mP9x.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toBe(
      "max-age=31536000, immutable",
    );
    expect(await res.text()).toBe(JS_CONTENT);

    // 无 hash 段的资源从简 no-cache
    const css = await fetch(`${server.baseUrl}/assets/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("cache-control")).toBe("no-cache");
  });

  it("SPA 回退：未命中路径回 index.html；HEAD 只回响应头", async () => {
    staticDir = makeStaticDir();
    server = await startTestServer({ static_dir: staticDir });

    const spa = await fetch(`${server.baseUrl}/businesses/abc123`);
    expect(spa.status).toBe(200);
    expect(await spa.text()).toBe(INDEX_HTML);

    const head = await fetch(`${server.baseUrl}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/html");
    expect(await head.text()).toBe("");
  });

  it("路径穿越 → 404 统一错误体（编码后的斜杠重组 .. 段）", async () => {
    staticDir = makeStaticDir();
    server = await startTestServer({ static_dir: staticDir });

    // 用 %2f（编码斜杠）重组出解码后才出现的 ".." 段——%2f 不被 URL 解析折叠，
    // decodeURIComponent 后才形成 ../ 逃逸，真正打到 serveStatic 的穿越防护上。
    // （%2e%2e 会被 WHATWG URL 解析预先归一化，到不了服务端，测不出防护。）
    const res = await fetch(`${server.baseUrl}/..%2f..%2fetc%2fpasswd`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("/api 前缀永远优先：不受静态分支影响（未登录 401）", async () => {
    staticDir = makeStaticDir();
    server = await startTestServer({ static_dir: staticDir });

    const res = await fetch(`${server.baseUrl}/api/auth/me`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthenticated");
  });

  it("index.html 不存在 → 404 统一错误体；非 GET/HEAD 走既有路由 404", async () => {
    staticDir = makeStaticDir({ withIndex: false });
    server = await startTestServer({ static_dir: staticDir });

    const res = await fetch(`${server.baseUrl}/anything`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");

    const posted = await fetch(`${server.baseUrl}/anything`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(posted.status).toBe(404);
  });

  it("未设置 static_dir：非 /api 请求 404（纯 API 服务形态）", async () => {
    server = await startTestServer();
    const res = await fetch(`${server.baseUrl}/`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});
