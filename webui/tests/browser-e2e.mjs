import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";

const origin = process.env.DFL_WEBUI_ORIGIN ?? "http://127.0.0.1:4173";
const browserChannel = process.env.DFL_E2E_BROWSER_CHANNEL;
const mutating = process.env.DFL_E2E_MUTATING === "1";
const modelName = process.env.DFL_E2E_MODEL_NAME ?? "web-smoke-128";
const appUrl = new URL(origin);
appUrl.searchParams.set("lang", "zh");

async function launch() {
  if (browserChannel) {
    return chromium.launch({ headless: true, channel: browserChannel });
  }

  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    if (!String(error?.message).includes("Executable doesn't exist")) throw error;
  }

  for (const channel of ["chrome", "msedge"]) {
    try {
      return await chromium.launch({ headless: true, channel });
    } catch {
      // Continue to the next installed system browser.
    }
  }

  throw new Error(
    "未找到 Playwright Chromium、Chrome 或 Edge；请运行 pnpm exec playwright install chromium",
  );
}

async function openApp(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(appUrl.href, { waitUntil: "domcontentloaded" });
  await page.getByText("本地服务在线", { exact: true }).waitFor({ timeout: 15000 });
  return { context, page };
}

test("DeepFaceLabSN browser E2E", { timeout: 240000 }, async (suite) => {
  const browser = await launch();
  suite.after(() => browser.close());

  await suite.test("刷新、参数向导、工作区与遥测", async () => {
    const { context, page } = await openApp(browser);
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByText("本地服务在线", { exact: true }).waitFor();
      assert.match(await page.title(), /DeepFaceLab 管理台/);

      await page.getByRole("button", { name: "新建任务", exact: true }).first().click();
      await page.getByRole("combobox", { name: "任务类型" }).selectOption("src.extract_faces");
      await page.getByRole("button", { name: "下一步", exact: true }).click();
      await page.getByRole("combobox", { name: "人脸图片尺寸" }).selectOption("128");
      await page.getByRole("button", { name: "下一步", exact: true }).click();
      await page.getByText("前置检查通过", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "启动任务", exact: true }).isEnabled(), true);
      await page.getByRole("button", { name: "关闭", exact: true }).click();

      await page.getByRole("button", { name: "工作区", exact: true }).click();
      await page.getByRole("heading", { name: "工作区管理", exact: true }).waitFor();
      await page.getByText("SRC 源视频", { exact: true }).waitFor();
      await page.getByText("DST 目标视频", { exact: true }).waitFor();
      assert.ok((await page.locator(".gpu-summary strong").textContent()).includes("NVIDIA"));
    } finally {
      await context.close();
    }
  });

  await suite.test("断线后轮询恢复", async () => {
    const { context, page } = await openApp(browser);
    let failNextHealth = true;
    try {
      await page.route("**/api/health", async (route) => {
        if (failNextHealth) {
          failNextHealth = false;
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              error: { code: "E2E_DISCONNECT", message: "模拟 Runtime 重启" },
            }),
          });
          return;
        }
        await route.continue();
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByText("本地服务离线", { exact: true }).first().waitFor({ timeout: 10000 });
      await page.getByText("本地服务在线", { exact: true }).waitFor({ timeout: 12000 });
    } finally {
      await context.close();
    }
  });

  await suite.test("真实 CLI 输入与 SAEHD 保存式停止", { skip: !mutating }, async () => {
    const { context, page } = await openApp(browser);
    try {
      await page.getByRole("button", { name: "新建任务", exact: true }).first().click();
      await page.getByRole("combobox", { name: "任务类型" }).selectOption("src.sort_faces");
      await page.getByRole("button", { name: "下一步", exact: true }).click();
      await page.getByRole("button", { name: "保留 CLI 问答", exact: true }).click();

      const cliInput = page.getByRole("textbox", { name: "CLI 输入" });
      await cliInput.waitFor({ state: "visible" });
      await cliInput.fill("10");
      await page.getByRole("button", { name: "发送", exact: true }).click();
      await page.waitForFunction(() => (
        document.querySelector('[aria-label="任务终端输出"]')?.textContent
          ?.includes("要使用的CPU核心数量")
      ), null, { timeout: 30000 });
      await page.getByRole("button", { name: "默认", exact: true }).click();
      await page.getByRole("tab", { name: /SRC 排序已完成/ }).waitFor({ timeout: 60000 });

      await page.getByRole("button", { name: "工作区", exact: true }).click();
      await page.getByRole("button", { name: "新建任务", exact: true }).first().click();
      await page.getByRole("combobox", { name: "任务类型" }).selectOption("train.saehd");
      await page.getByRole("button", { name: "下一步", exact: true }).click();
      await page.getByRole("spinbutton", { name: "目标迭代数" }).fill("1100");
      await page.getByRole("checkbox", { name: "静默继续最近模型" }).check();
      await page.getByRole("button", { name: "显示高级参数", exact: true }).click();
      await page.getByRole("textbox", { name: "指定模型名称" }).fill(modelName);
      await page.getByRole("textbox", { name: "GPU 索引" }).fill("0");
      await page.getByRole("button", { name: "下一步", exact: true }).click();
      await page.getByText("前置检查通过", { exact: true }).waitFor();
      await page.getByRole("button", { name: "启动任务", exact: true }).click();
      await page.getByRole("tab", { name: /SAEHD运行中/ }).waitFor({ timeout: 60000 });

      await page.getByRole("button", { name: "安全停止", exact: true }).click();
      await page.getByRole("button", { name: "保存并停止", exact: true }).click();
      await page.getByRole("tab", { name: /SAEHD已完成/ }).first().waitFor({ timeout: 90000 });
      assert.match(
        await page.getByLabel("任务终端输出").innerText(),
        /任务结束 · succeeded · exit 0/,
      );
    } finally {
      await context.close();
    }
  });
});
