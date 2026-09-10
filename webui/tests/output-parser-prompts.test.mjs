import assert from "node:assert/strict";
import test from "node:test";
import { OutputParser } from "../server/output-parser.mjs";

test("DFL default-value questions are exposed as input prompts in both languages", () => {
  for (const prompt of [
    "[n] 将调试图像写入 aligned_debug? ( y/n ) : ",
    "[n] Write debug images to aligned_debug? ( y/n ) : ",
    "[128] 分辨率 resolution ( 64-640 ?:help ) : ",
    "[wf] Face type ( h/mf/f/wf/head ?:help ) : ",
    "[] Model author : ",
  ]) {
    const parser = new OutputParser();
    const split = prompt.indexOf(":");
    assert.deepEqual(parser.push(`\u001b[32m${prompt.slice(0, split)}`), []);
    assert.deepEqual(parser.push(`${prompt.slice(split)}\u001b[0m`), [{
      type: "terminal.prompt", payload: { prompt: prompt.trim() },
    }]);
    assert.deepEqual(parser.push("\u001b[?25h"), []);
  }
});

test("DFL status output and training instructions do not become input prompts", () => {
  for (const output of [
    "[WEB] 提取 SRC 人脸\r\n",
    "[12:00:00][#000123][0450ms][0.4321][0.5678]\r",
    "[n] 按 Enter 停止训练并保存进度 : ",
    "Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 25 fps\r\n",
    "合成进度:  52%|#####| 47/90 [00:14<00:13, 3.29it/s]",
  ]) assert.equal(new OutputParser().push(output).some(event => event.type === "terminal.prompt"), false);
});

test("DFL overwrite confirmations expose the final Enter-to-continue line", () => {
  for (const prompt of ["按 Enter 继续.", "按回车键继续。", "Press enter to continue."]) {
    const events = new OutputParser().push(`警告 !!!\r\naligned 包含文件!\r\n它们将被删除.\r\n ${prompt}\r\n`);
    assert.deepEqual(events, [{ type: "terminal.prompt", payload: { prompt } }]);
  }
});
