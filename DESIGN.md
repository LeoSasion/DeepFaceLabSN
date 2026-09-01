---
name: DeepFaceLabSN
description: 安静、精确、可持续监视的本地 DeepFaceLab 训练驾驶舱
colors:
  primary: "#2ce39f"
  primary-strong: "#54f4bb"
  primary-deep: "#0c3d2d"
  warning: "#f3b83f"
  warning-deep: "#3b2d0f"
  xseg: "#bf6cff"
  danger: "#ff5a46"
  danger-deep: "#40150f"
  canvas: "#030706"
  canvas-raised: "#07100d"
  surface: "#08120e"
  surface-raised: "#0b1712"
  border: "#163326"
  border-strong: "#21503a"
  text: "#eaf4ee"
  text-soft: "#c0ccc5"
  text-muted: "#829087"
typography:
  headline:
    fontFamily: "Microsoft YaHei UI, Noto Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "clamp(18px, 1.45vw, 22px)"
    fontWeight: 640
    lineHeight: 1.2
    letterSpacing: "0.005em"
  title:
    fontFamily: "Microsoft YaHei UI, Noto Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 690
    lineHeight: 1.35
    letterSpacing: "normal"
  body:
    fontFamily: "Microsoft YaHei UI, Noto Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  label:
    fontFamily: "Microsoft YaHei UI, Noto Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "0.01em"
  mono:
    fontFamily: "Cascadia Code, SFMono-Regular, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
    letterSpacing: "normal"
rounded:
  xs: "2px"
  sm: "4px"
  control: "5px"
  panel: "8px"
  dialog: "10px"
  feature: "12px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  2xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary-deep}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "38px"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-soft}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "38px"
  button-danger:
    backgroundColor: "{colors.danger-deep}"
    textColor: "{colors.danger}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "38px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "12px"
  field:
    backgroundColor: "{colors.canvas-raised}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "36px"
  status-active:
    backgroundColor: "{colors.primary-deep}"
    textColor: "{colors.primary-strong}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "4px 8px"
  workflow-current:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "5px 6px"
---

# Design System: DeepFaceLabSN

## Overview

**Creative North Star: “本地训练驾驶舱”**

DeepFaceLabSN 应像一套安静运行的专业编辑控制台：信息密集，但层级稳定；状态清楚，但不靠大面积高饱和色制造噪声。它服务的是长时间本地任务和高频视觉判断，因此界面的价值来自可扫描性、真实反馈和操作信心，而不是装饰性仪表盘效果。

视觉语言以近黑森林色画布、低对比度分层表面和细边界构成。翡翠绿承担产品主行动与实时状态；琥珀、红色分别承担等待/提醒与失败；紫色只作为 XSeg 的功能身份。产品保持专业编辑控制台的克制感，拒绝营销页式的大卡片、大留白和无意义发光。

**Key Characteristics:**

- 近黑森林色的本地工作台，长时间使用不刺眼。
- 紧凑但不微小：正文不低于 12px，辅助标签不低于 11px。
- 状态、当前视图和功能身份各自独立，不用一种颜色混淆多种语义。
- 扁平分层为主，边框和色调承担结构，阴影只用于悬浮、对话框和短暂强调。
- 终端是任务队列与原始证据的唯一入口，界面不会复制第二套队列。

## Colors

色彩以低明度中性背景托住少量高辨识度状态色，任何强调色都必须对应明确操作或状态。

### Primary

- **仪表翡翠**（`primary` / `primary-strong`）：主按钮、正在运行、选中边缘和键盘焦点；用量应克制。
- **深舱绿**（`primary-deep`）：主行动和选中态的承托面，不作为大面积页面背景。

### Secondary

- **等待琥珀**（`warning` / `warning-deep`）：等待输入、需要注意、尚未就绪；不再承担普通功能分类。

### Tertiary

- **XSeg 紫**（`xseg`）：只标记 XSeg 导航、图标与数据身份，不能替代状态色。
- **故障红**（`danger` / `danger-deep`）：失败、危险操作和不可继续状态；必须同时附带文字或图标。

### Neutral

- **深夜画布**（`canvas` / `canvas-raised`）：应用外壳、终端和最深层背景。
- **森林表面**（`surface` / `surface-raised`）：面板、工具区和悬停承托层。
- **苔藓边界**（`border` / `border-strong`）：结构分隔、面板轮廓和交互边界。
- **冷白文本**（`text` / `text-soft` / `text-muted`）：主内容、说明和低优先级元数据。

**The Semantic Color Rule.** 绿色表示行动或成功，琥珀表示等待或注意，红色表示失败，紫色表示 XSeg 身份；不得按页面喜好重新解释。

**The Accent Rationing Rule.** 高饱和色只出现在可操作点和状态证据上，静态大面积表面保持中性。

## Typography

- **Display Font:** Microsoft YaHei UI（中文系统字体回退）
- **Body Font:** Microsoft YaHei UI（Noto Sans SC 与系统字体回退）
- **Label/Mono Font:** Cascadia Code（Consolas 与等宽字体回退）

**Character:** 中文界面以清晰、稳健的系统无衬线体为主；路径、PID、命令和终端输出使用等宽字体，使技术证据能快速纵向扫描。

### Hierarchy

- **Headline**（640，流体 18–22px，1.2）：项目名和页面主标题。
- **Title**（690，14px，1.35）：面板标题、关键空状态和重要分区。
- **Body**（400，12px，1.5）：说明、数据行和常规操作文案。
- **Label**（600，11px，0.01em）：短标签、元数据键和状态辅助文案；11px 是桌面下限。
- **Mono**（400，12px，1.45）：终端、路径、命令、数值标识和文件名。

**The No Microtype Rule.** 不使用小于 11px 的正文字号；空间不足时先压缩重复信息、改变布局或允许滚动。

**The Numeric Scan Rule.** 迭代、损失、显存、PID 和时长使用等宽数字或等宽字体，并与字段名保留明确间距或分隔线。

## Layout

桌面基准为 1920×1080。应用由 42px 品牌栏、左侧功能域导航、顶部项目头和九步流程条、主工作区以及底部终端组成。总览在宽桌面采用三栏：约 248px 的流水线、弹性主预览、360–440px 的实时状态栏，栏间保持紧凑的 8px 间距。

1240px 以下左侧导航折叠为 76px 图标栏，三栏缩为 210px / 弹性主区 / 330–360px；界面不再整体缩放，文字保持真实像素尺寸。1020px 以下状态栏换到下一行，780px 以下进入纵向滚动与横向导航模式。终端在 16:9 基准下必须可见，不能依赖缩窄窗口才出现。

空间节奏优先采用 4、6、8、12、16、24px。面板内部信息按扫描关系分组，而不是为追求对称平均分布；宽屏增加的是有效阅读宽度，不是字段之间的空洞。

**The Density With Hierarchy Rule.** 可以紧凑，但每个 8–16px 间距都应表达分组；禁止用大留白掩盖重复或稀疏的信息架构。

## Elevation & Depth

系统默认扁平。深度主要由相邻表面的轻微明度差、1px 苔藓色边界和极弱内高光构成。按钮悬停可以轻微上移并增加环境阴影；对话框和全局错误卡才使用明显投影。焦点光环属于可访问性反馈，不是装饰性霓虹。

### Shadow Vocabulary

- **面板内高光**（`inset 0 1px rgb(255 255 255 / 0.018–0.025)`）：区分贴近的深色表面。
- **按钮悬浮**（`0 7px 18px rgb(0 0 0 / 0.24)`，悬停增强）：只用于主要行动的交互反馈。
- **对话框环境阴影**（`0 24px 80px rgb(0 0 0 / 0.46)`）：模态与致命错误层。

**The Flat-By-Default Rule.** 常驻面板不使用外投影；只有浮层、主要按钮悬停和短暂状态反馈可以离开平面。

## Shapes

形状克制、机械而不尖锐。常规控件使用 5px 圆角，主要面板使用 8px，对话框和大型独立容器使用 10–12px；细进度条、分隔标记可使用 2–4px。圆形只用于状态点、头像或明确的图标按钮，药丸形只用于极短的状态标签。

边框必须服从全局深色工作台语言：细、低对比、同色相。不要为单个统计区引入明亮矩形描边或与全局不一致的卡片风格。

## Components

### Buttons

- **Shape:** 紧凑矩形，常规 5px 圆角，最小高度 38px。
- **Primary:** 深舱绿表面、翡翠边界与冷白文字，水平内边距 16px。
- **Hover / Focus:** 悬停上移 2px并加深表面；键盘焦点使用 2px 明亮翡翠轮廓和外扩光环；减弱动态偏好下取消可感知位移。
- **Secondary / Danger:** 次按钮使用森林中性表面；危险按钮使用深红承托面，且保持明确文字标签。

### Chips

- **Style:** 仅用于短状态和过滤条件；5px 圆角、细边界、11px 标签。
- **State:** 颜色来自统一状态语义，不按模块临时选色；禁用态降低不透明度但保留可读文字。

### Cards / Containers

- **Corner Style:** 面板 8px，独立大型工作台 7–10px。
- **Background:** 森林表面与轻微纵向渐变。
- **Shadow Strategy:** 常驻卡片无外投影，以边界和内高光分层。
- **Border:** 1px 苔藓色低对比边界。
- **Internal Padding:** 紧凑区域 8–12px，标题栏横向 14px。

### Inputs / Fields

- **Style:** 深夜承托面、1px 边界、5px 圆角、最小高度 36px；路径与命令使用等宽字体。
- **Focus:** 统一翡翠轮廓，不能只改变边框颜色。
- **Error / Disabled:** 错误附带红色、图标和文字；禁用态保留上下文但降低不透明度。

### Navigation

左侧导航负责功能域，顶部流程负责制作顺序；两者都必须可点击并同步当前视图。当前视图使用中性深绿承托面和内轮廓，真实运行状态仍由独立颜色与文字表达。1240px 以下侧栏只保留图标，但按钮继续提供可访问名称和提示。

### Runtime Console

终端标签是任务队列和日志的唯一显示面。已结束标签可关闭并支持批量清理；活动和当前标签必须保留。终端头只显示运行状态、时长、运行时和新建任务，完整命令与任务目录放在右侧会话详情中，避免重复占据横向空间。

空项目首次进入时，主视图跟随真实工作区进入下一项合法操作：缺素材进入工作区，缺帧进入提帧，缺人脸进入切脸。该引导只在首次快照生效；用户主动导航后，刷新和后台状态变化不得抢走当前页面。终端空态只保留一个推荐动作、三个常用入口与完整命令目录。

### Dataset Inspectors and XSeg

SRC、DST 与 XSeg 的右侧检查器统一采用“顶部上下文栏—中间 1:1 预览—底部动作栏”。预览使用上下栏之间的全部高度反推右栏宽度，左侧素材列表承担剩余横向空间；窄视口改为上下堆叠，但不得拉伸、裁切图片或在预览下方留下空带。

SRC / DST 底栏提供 XSeg 编辑、清晰增强、单图合成和 AI 图像编辑入口。尚未接入计算能力的入口必须跳转到明确标注“规划中”的页面，不伪造可用状态、结果或进度；外部图像 API 在上传前必须让用户明确确认服务商与本次素材范围。

### Progress Feedback

能计算总量时显示真实百分比、已处理数和 ETA；不能计算时显示明确的不定进度与当前阶段，不伪造百分比。进度条使用翡翠主轨，警告和失败状态继承统一语义色，并尊重减弱动态偏好。

所有长操作统一登记到右下角悬浮 HUD，不占据文档流，因此出现和消失不能推动页面布局。可取消操作显示明确取消按钮，并把取消信号传到实际子进程；不可取消操作不显示无效动作。后台操作记录必须持久化，服务重启后把未完成记录标为“已中断”，而不是继续显示正在运行。

同一后台操作在全局 HUD 只显示一次；页面内可以保留上下文骨架或阶段说明，但不得再注册第二张泛化进度卡。真实总量尚不可得时保持不定进度，不能用固定步骤伪装计算百分比。

### Recovery and Diagnostics

恢复入口跟随被保护的对象：素材历史位于 SRC / DST 素材卡，隔离图片位于数据集工作区，帧与对齐备份位于对应工具。恢复列表只显示时间、类型、大小和安全令牌，不暴露绝对路径；覆盖当前内容前必须确认，并自动为当前版本生成可撤销归档。

工作区始终保留 5 GB 磁盘安全余量。已知大小的导入在写入前检查可用空间；空间不足时以琥珀色说明缺口，而不是等到传输中途失败。诊断摘要可由用户主动导出，但只包含版本、就绪度、硬件摘要、存储和任务状态，不包含绝对路径、命令参数或终端内容。

### Accessible Editing

XSeg 多边形和 68 点定位不仅支持指针拖动，也必须支持 Tab 选择顶点、方向键 1px 微调、Shift + 方向键 5px 微调以及 Delete 删除，并通过读屏状态播报当前点和坐标。分页、筛选、图标按钮与文件输入均需提供可访问名称；触控设备上的主要操作热区不小于 44×44px。

## Do's and Don'ts

### Do:

- **Do** 在 1920×1080 与 1220×1040 两个桌面视口验证关键流程和终端可见性。
- **Do** 把重复的完成步骤折叠，把当前、下一步和失败项留在视觉前景。
- **Do** 让状态同时具备颜色、文字和必要图标，并保留真实任务状态。
- **Do** 在等待、空数据、失败、无权限和长内容状态下提供明确下一步。
- **Do** 使用虚构成年人或已获明确授权的肖像作为演示素材。
- **Do** 在发布前运行隔离工作区测试、生产构建、静态文案检查和浏览器多视口验收。

### Don't:

- **Don't** 通过整体缩放界面来适配较窄桌面，这会重新制造不可读的小字。
- **Don't** 同时维护终端标签与第二套任务队列或“查看全部命令日志”入口。
- **Don't** 用琥珀色表示普通模块身份，或用紫色表示失败/等待。
- **Don't** 把模型训练预览、训练诊断和姿态图谱塞进同一页面；它们有不同的决策职责。
- **Don't** 为填满宽屏而平均拉开字段；优先重组信息关系和加入分隔。
- **Don't** 在运行中的预览服务旁自动重建依赖；依赖不一致必须先报错并由发布流程显式处理。
