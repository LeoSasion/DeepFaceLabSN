# DeepFaceLabSN

最新整合包夸克网盘：https://pan.quark.cn/s/e1a677c7d8a7
更新日志：https://bbs.monster/thread-692-1-1.html

## 启动入口

- `启动 WebUI.bat`：推荐入口，启动本地 Web 管理器与 Runtime。
- `传统命令菜单.bat`：启动交互式 CLI 路由器，按视频、SRC、DST、XSeg、训练、模型应用、封装和工具分类运行传统命令。

传统 BAT 已集中到 `legacy-cli`。CLI 路由器会动态枚举白名单命令，并提供最近使用、显卡/RG、WebUI 和 Explorer 兼容菜单入口；默认无需运行初始化 BAT。

更多说明见 `webui/README.md`、`webui/ARCHITECTURE.md` 和 `docs/TAKEOVER_BASELINE.md`。
