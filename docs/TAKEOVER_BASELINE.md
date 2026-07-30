# DeepFaceLabSN 接管基线

基线日期：2026-07-29

基线提交：`875253f`（`main` / `origin/main`，v3.1.0）

打包运行时：Python 3.7.1

## 保护措施

- 接管前的受控文件差异保存在
  `docs/baseline/pre-hardening-tracked-2026-07-29.patch`。
- 接管时存在的未跟踪非缓存资产及 SHA-256 保存在
  `docs/baseline/untracked-assets-2026-07-29.sha256`。
- Python 缓存、Visual Studio 本地目录和 `desktop.ini` 已加入忽略规则；没有删除这些本地文件。
- 未自动暂存、提交或覆盖工作区中的其他修改。

恢复接管前受控文件差异时，应在干净的 `875253f` 工作树上审阅后执行：

```powershell
git apply --check docs/baseline/pre-hardening-tracked-2026-07-29.patch
git apply docs/baseline/pre-hardening-tracked-2026-07-29.patch
```

## 接管前修改分类

| 类别 | 文件/改动 | 处理 |
| --- | --- | --- |
| 配置 | `.gitignore` 忽略 `pretrain_Quick384` | 保留 |
| 初始化 | 修复 `Recent Tse` 拼写和汉化仓库 URL；迁入 `legacy-cli` 后仅负责二级菜单显示 | 保留 |
| 旧入口退役 | 删除 AMP 训练/导出入口及 Quick224 训练/导出/合成入口 | 保留；同步清理菜单引用 |
| Quick512 | 移除 `--silent-start`，保留 Flask 预览 | 保留 |
| Quick384 | 更新量化提示；快速模式 `ct_mode` 从字符串 `"none"` 改为 `None` | 保留 |
| SAEHD | SRC 曾误指向 `data_dst` | 已恢复为 `data_src`，当前与 Git 基线一致 |

AMP 的合成入口仍然保留，用于已有 AMP 模型；只移除了已经不存在的 AMP 导出菜单项。

## 未跟踪内容分类

- 分发候选资产：Aligned 图片浏览器、`data.json`、Landmark 使用说明图片；目录优化后集中在 `legacy-cli`。
- 本地系统文件：`desktop.ini`。
- 可再生噪声：`__pycache__`、`.pyc`、未跟踪 `.vs` 目录。

未跟踪资产没有被删除或加入 Git；基线哈希清单保留接管时的原始路径，仅用于完整性校验。

## 依赖与验证

- 打包环境精确包版本：
  `docs/baseline/requirements-bundled-2026-07-29.txt`。
- 声明依赖 `_internal/DeepFaceLab/requirements-cuda.txt` 与实际打包环境存在版本漂移；以打包快照作为当前运行基线。
- 最小烟雾测试：

```powershell
tools\smoke_test.bat
```

烟雾测试只读执行以下检查：

1. 必需的运行时、模型和 workspace 路径存在。
2. `_internal/DeepFaceLab` 下全部 Python 源文件可编译为 AST，不生成 `.pyc`。
3. 根目录只保留 WebUI 与传统菜单两个 BAT 入口。
4. 传统菜单通过白名单式 CLI 路由器动态枚举分类，并能通过只读自检。
5. `legacy-cli` 中所有批处理菜单引用均指向实际存在的 `.bat`。
6. SAEHD 的 SRC/DST 路径分别指向 `data_src`/`data_dst`。
7. 当前安装包版本与依赖快照一致。
8. `pip check` 不报告破损依赖。

该测试不加载 TensorFlow、不初始化 GPU，也不开始训练或合成。
