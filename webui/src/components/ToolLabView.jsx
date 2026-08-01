import { useCallback, useEffect, useMemo, useState } from "react";
import {
  IconAlertTriangle,
  IconArchive,
  IconArrowRight,
  IconCheck,
  IconCode,
  IconFileAnalytics,
  IconPhoto,
  IconPlayerPlay,
  IconRefresh,
  IconRoute,
  IconTool,
} from "@tabler/icons-react";
import { runtimeApi } from "../runtime/api.js";
import { useI18n } from "../i18n.jsx";
import { CommandRows } from "./OperationsView.jsx";

const QUALITY_LABELS = ["< 0.2", "0.2 – 0.4", "0.4 – 0.6", "0.6 – 0.8", "> 0.8"];

const MIGRATION_GROUPS = [
  {
    id: "shipped",
    label: "已 Web 化",
    rows: [
      {
        id: "xseg",
        name: "XSeg 多边形编辑器",
        source: "_internal/DeepFaceLab/XSegEditor/XSegEditor.py",
        interaction: "Canvas 多边形、顶点拖拽、include / exclude 与 JPG 原位保存",
        status: "已上线",
        priority: "完成",
        detail: "已直接读写 SegIEPolys，不依赖 PyQt 窗口，也保留可恢复的素材隔离路径。",
      },
      {
        id: "trainer",
        name: "Trainer 预览与控制",
        source: "_internal/DeepFaceLab_old/mainscripts/Trainer.py",
        interaction: "实时预览、损失曲线、保存、备份、刷新与安全停止",
        status: "已上线",
        priority: "完成",
        detail: "通过文件控制桥与真实训练进程通信，不模拟键盘输入或抓取外部窗口。",
      },
      {
        id: "facegrid",
        name: "FaceGrid 人脸姿态图谱",
        source: "_internal/facesets/UI/controls/facegrid.py",
        interaction: "Yaw × Pitch 分布、清晰度审查、样本回看与可恢复隔离",
        status: "本次新增",
        priority: "完成",
        detail: "复用原工具的 landmarks 姿态估计，将密集 PyQt 网格升级为可筛选、可审查的 Web 技术画布。",
      },
    ],
  },
  {
    id: "native-ui",
    label: "下一批原生 UI",
    rows: [
      {
        id: "manual-extractor",
        name: "Manual Extractor",
        source: "_internal/DeepFaceLab/mainscripts/Extractor.py",
        interaction: "逐帧画框、landmarks 覆盖、缩放平移、接受/跳过与批量复核",
        status: "待迁移",
        priority: "P0",
        detail: "建议做成全屏审片台：中央源帧画布、右侧候选人脸、底部帧带，并保留原快捷键节奏。",
      },
      {
        id: "interactive-merger",
        name: "Interactive Merger",
        source: "_internal/DeepFaceLab/merger/InteractiveMergerSubprocessor.py",
        interaction: "逐帧 A/B 预览、遮罩/腐蚀/模糊/色彩参数侧栏与时间轴缓存",
        status: "待迁移",
        priority: "P0",
        detail: "适合以大画布和可折叠参数轨道替代原按键屏幕；每次改参只重算当前帧，确认后批量合成。",
      },
      {
        id: "faceset-preview",
        name: "Faceset 姿态格预览",
        source: "_internal/facesets/UI/Ui_previewUI.py",
        interaction: "姿态格样本对照、SRC/DST 数量差与清晰度分布",
        status: "已并入图谱",
        priority: "P1",
        detail: "原弹窗能力已被本次右侧检查器吸收；后续只需补充多选姿态的精确打包。",
      },
    ],
  },
  {
    id: "planned",
    label: "可视化规划",
    rows: [
      {
        id: "sorter",
        name: "Sorter 清洗工作台",
        source: "_internal/DeepFaceLab/mainscripts/Sorter.py",
        interaction: "按模糊/姿态/直方图排序，双图比较，先隔离后提交",
        status: "可设计",
        priority: "P1",
        detail: "把不可逆重命名改成预览队列：先显示排序理由和异常分数，再通过隔离区提交或回滚。",
      },
      {
        id: "videoed",
        name: "VideoEd 视频工具",
        source: "_internal/DeepFaceLab/mainscripts/VideoEd.py",
        interaction: "时间码裁剪、抽帧范围、降噪强度与前后帧对比",
        status: "可设计",
        priority: "P1",
        detail: "用时间轴、关键帧缩略图和局部预览代替 CLI 问答；运行仍走固定白名单命令。",
      },
      {
        id: "metadata-pack",
        name: "Metadata / PackedFaceset",
        source: "_internal/DeepFaceLab/mainscripts/Util.py · samplelib/PackedFaceset.py",
        interaction: "元数据版本时间线、差异预览、包内容清单与恢复点",
        status: "可设计",
        priority: "P2",
        detail: "把 save/restore/pack/unpack 组织成可审计的版本流，显示影响文件数、目标路径和冲突。",
      },
    ],
  },
];

function formatAngle(value) {
  if (value === 0) return "0°";
  return `${value > 0 ? "+" : ""}${value}°`;
}

function emptyAtlas(side) {
  return {
    side,
    total: 0,
    validCount: 0,
    invalidCount: 0,
    lowQualityCount: 0,
    meanSharpness: 0,
    coverage: 0,
    lowQualityThreshold: 0.24,
    cells: [],
    yawTicks: [],
    pitchTicks: [],
  };
}

function PoseAtlas({ side, refreshVersion, onError, onNotice, onNavigateDataset, onOpenCommand }) {
  const { t } = useI18n();
  const [atlas, setAtlas] = useState(() => emptyAtlas(side));
  const [selectedId, setSelectedId] = useState(null);
  const [metric, setMetric] = useState("count");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [localRefresh, setLocalRefresh] = useState(0);

  const loadAtlas = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await runtimeApi.alignedPoseAtlas(side);
      setAtlas(next);
      setSelectedId((current) => {
        if (current && next.cells.some((cell) => cell.id === current && cell.count)) return current;
        const fullest = next.cells.reduce(
          (best, cell) => (cell.count > (best?.count ?? 0) ? cell : best),
          null,
        );
        return fullest?.count ? fullest.id : null;
      });
    } catch (error) {
      setLoadError(error);
      onError(error);
    } finally {
      setLoading(false);
    }
  }, [onError, side]);

  useEffect(() => {
    void loadAtlas();
  }, [loadAtlas, localRefresh, refreshVersion]);

  const selected = atlas.cells.find((cell) => cell.id === selectedId) ?? null;
  const maxCount = useMemo(
    () => Math.max(1, ...atlas.cells.map((cell) => cell.count)),
    [atlas.cells],
  );
  const visibleLowQuality = selected?.samples.filter(
    (sample) => sample.sharpness < atlas.lowQualityThreshold,
  ) ?? [];

  const quarantineVisible = async () => {
    if (!visibleLowQuality.length) return;
    const confirmed = window.confirm(t(
      "将当前姿态格中的 {count} 张低清晰度样本移入可恢复隔离区吗？",
      { count: visibleLowQuality.length },
    ));
    if (!confirmed) return;
    try {
      for (const sample of visibleLowQuality) {
        await runtimeApi.quarantineAligned(side, sample.name);
      }
      onNotice(t("已隔离 {count} 张低清晰度样本，可在数据集页面恢复", {
        count: visibleLowQuality.length,
      }));
      setLocalRefresh((value) => value + 1);
    } catch (error) {
      onError(error);
    }
  };

  if (loading && !atlas.cells.length) {
    return (
      <div className="pose-atlas-state" role="status">
        <IconFileAnalytics size={28} />
        <strong>{t("正在分析 aligned landmarks…")}</strong>
        <span>{t("姿态与清晰度计算在本地 Python 运行时完成")}</span>
      </div>
    );
  }

  if (loadError && !atlas.cells.length) {
    return (
      <div className="pose-atlas-state is-error">
        <IconAlertTriangle size={28} />
        <strong>{t("姿态分析未完成")}</strong>
        <span>{t(loadError.message)}</span>
        <button className="button secondary" type="button" onClick={() => setLocalRefresh((value) => value + 1)}>
          <IconRefresh size={15} />{t("重试分析")}
        </button>
      </div>
    );
  }

  if (!atlas.validCount) {
    return (
      <div className="pose-atlas-state">
        <IconPhoto size={28} />
        <strong>{t("还没有可分析的 aligned 人脸")}</strong>
        <span>{t("先完成 {side} 人脸提取，再回到这里检查姿态覆盖。", { side: side.toUpperCase() })}</span>
        <button className="button primary" type="button" onClick={() => onOpenCommand(`${side}.extract_faces`)}>
          <IconPlayerPlay size={15} />{t("打开人脸提取")}
        </button>
      </div>
    );
  }

  return (
    <div className="pose-atlas-layout">
      <section className="pose-atlas-main" aria-label={t("人脸姿态分布") }>
        <div className="pose-metrics">
          <div><span>{t("有效人脸")}</span><strong>{atlas.validCount.toLocaleString()}</strong></div>
          <div><span>{t("姿态覆盖")}</span><strong>{(atlas.coverage * 100).toFixed(1)}%</strong></div>
          <div className={atlas.lowQualityCount ? "is-warning" : ""}>
            <span>{t("待审素材")}</span><strong>{atlas.lowQualityCount.toLocaleString()}</strong>
          </div>
          <div><span>{t("平均清晰度")}</span><strong>{atlas.meanSharpness.toFixed(3)}</strong></div>
          <div className="pose-metric-toggle" role="group" aria-label={t("图谱指标") }>
            <button className={metric === "count" ? "is-active" : ""} type="button" onClick={() => setMetric("count")}>{t("数量")}</button>
            <button className={metric === "quality" ? "is-active" : ""} type="button" onClick={() => setMetric("quality")}>{t("清晰度")}</button>
          </div>
        </div>

        <div className="pose-chart-heading">
          <span>{t("左右角 Yaw")}</span>
          <small>{t("点击格子检查该姿态的低清晰度样本")}</small>
        </div>
        <div className="pose-matrix">
          <div className="pose-pitch-title">{t("俯仰角 Pitch")}</div>
          <div className="pose-matrix-content">
            <div className="pose-yaw-labels" style={{ gridTemplateColumns: `repeat(${atlas.yawTicks.length}, minmax(34px, 1fr))` }}>
              {atlas.yawTicks.map((yaw) => <span key={yaw}>{formatAngle(yaw)}</span>)}
            </div>
            <div className="pose-matrix-body">
              <div className="pose-pitch-labels" style={{ gridTemplateRows: `repeat(${atlas.pitchTicks.length}, minmax(31px, 1fr))` }}>
                {atlas.pitchTicks.map((pitch) => <span key={pitch}>{formatAngle(pitch)}</span>)}
              </div>
              <div
                className="pose-cells"
                style={{
                  gridTemplateColumns: `repeat(${atlas.yawTicks.length}, minmax(34px, 1fr))`,
                  gridTemplateRows: `repeat(${atlas.pitchTicks.length}, minmax(31px, 1fr))`,
                }}
              >
                {atlas.cells.map((cell) => {
                  const level = metric === "quality"
                    ? cell.meanSharpness
                    : Math.log1p(cell.count) / Math.log1p(maxCount);
                  const isRelevantGap = !cell.count && Math.abs(cell.yaw) <= 60 && Math.abs(cell.pitch) <= 45;
                  return (
                    <button
                      className={`pose-cell ${selectedId === cell.id ? "is-selected" : ""} ${isRelevantGap ? "is-gap" : ""} ${cell.lowQualityCount ? "has-low-quality" : ""}`}
                      key={cell.id}
                      type="button"
                      aria-label={t("Yaw {yaw}，Pitch {pitch}，{count} 张", {
                        yaw: formatAngle(cell.yaw),
                        pitch: formatAngle(cell.pitch),
                        count: cell.count,
                      })}
                      aria-pressed={selectedId === cell.id}
                      disabled={!cell.count}
                      onClick={() => setSelectedId(cell.id)}
                      style={{ "--pose-level": level.toFixed(3) }}
                    >
                      {metric === "quality" && cell.count
                        ? `${Math.round(cell.meanSharpness * 100)}%`
                        : cell.count.toLocaleString()}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
        <div className="pose-legend">
          <span><i style={{ "--legend-level": 0.18 }} />{t("稀少")}</span>
          <span><i style={{ "--legend-level": 0.48 }} />{t("适中")}</span>
          <span><i style={{ "--legend-level": 0.9 }} />{t("密集")}</span>
          <span className="is-gap"><i />{t("覆盖缺口")}</span>
          <small>{t("分析基于 DFL landmarks；清晰度为 Laplacian 方差归一化结果")}</small>
        </div>
      </section>

      <aside className="pose-inspector" aria-label={t("已选姿态检查器") }>
        <header>
          <div>
            <span>{t("已选姿态")}</span>
            <strong>{selected ? `Yaw ${formatAngle(selected.yaw)} · Pitch ${formatAngle(selected.pitch)}` : t("未选择")}</strong>
          </div>
          <span>{selected?.count ?? 0}</span>
        </header>

        {selected ? (
          <>
            <div className="pose-inspector-summary">
              <div><span>{t("平均清晰度")}</span><strong>{selected.meanSharpness.toFixed(3)}</strong></div>
              <div><span>{t("平均亮度")}</span><strong>{selected.meanBrightness.toFixed(3)}</strong></div>
            </div>
            <section className="pose-samples">
              <h3>{t("低清晰度优先样本")}</h3>
              <div>
                {selected.samples.slice(0, 6).map((sample) => (
                  <button key={sample.name} type="button" title={sample.sourceFilename ?? sample.name} onClick={() => onNavigateDataset(side, sample)}>
                    <img src={sample.imageUrl} alt="" />
                    <span>{sample.sharpness.toFixed(2)}</span>
                  </button>
                ))}
              </div>
            </section>
            <section className="quality-distribution">
              <h3>{t("清晰度分布")}</h3>
              {selected.qualityBands.map((count, index) => (
                <div key={QUALITY_LABELS[index]}>
                  <span>{QUALITY_LABELS[index]}</span>
                  <i><b style={{ width: `${selected.count ? (count / selected.count) * 100 : 0}%` }} /></i>
                  <small>{count}</small>
                </div>
              ))}
            </section>
            <div className="pose-inspector-actions">
              <button type="button" onClick={() => onNavigateDataset(side, selected.samples[0])} disabled={!selected.samples.length}>
                <IconPhoto size={15} /><span>{t("在数据集浏览器中查看")}</span><IconArrowRight size={14} />
              </button>
              <button className="is-warning" type="button" onClick={() => void quarantineVisible()} disabled={!visibleLowQuality.length}>
                <IconArchive size={15} /><span>{t("隔离可见低质样本")}</span><small>{visibleLowQuality.length}</small>
              </button>
              <button type="button" onClick={() => onOpenCommand(`${side}.faces_pack`)}>
                <IconCode size={15} /><span>{t("打开整库打包命令")}</span><IconArrowRight size={14} />
              </button>
            </div>
          </>
        ) : (
          <div className="pose-inspector-empty"><IconRoute size={26} />{t("选择一个有素材的姿态格")}</div>
        )}
      </aside>
    </div>
  );
}

function MigrationMap() {
  const { t } = useI18n();
  const allRows = MIGRATION_GROUPS.flatMap((group) => group.rows);
  const [selectedId, setSelectedId] = useState("manual-extractor");
  const selected = allRows.find((row) => row.id === selectedId) ?? allRows[0];
  return (
    <div className="migration-layout">
      <section className="migration-table-wrap">
        {MIGRATION_GROUPS.map((group) => (
          <section className="migration-group" key={group.id}>
            <header><h3>{t(group.label)}</h3><span>{group.rows.length}</span></header>
            <div className="migration-table" role="table" aria-label={t(group.label)}>
              {group.rows.map((row) => (
                <button
                  className={selectedId === row.id ? "is-selected" : ""}
                  key={row.id}
                  type="button"
                  role="row"
                  onClick={() => setSelectedId(row.id)}
                >
                  <span className="migration-name" role="cell"><strong>{t(row.name)}</strong><small>{row.source}</small></span>
                  <span className="migration-interaction" role="cell">{t(row.interaction)}</span>
                  <span className={`migration-status is-${group.id}`} role="cell">{t(row.status)}</span>
                  <span className="migration-priority" role="cell">{row.priority}</span>
                  <IconArrowRight size={15} />
                </button>
              ))}
            </div>
          </section>
        ))}
      </section>
      <aside className="migration-detail">
        <IconTool size={22} />
        <h3>{t(selected.name)}</h3>
        <p>{t(selected.detail)}</p>
        <dl>
          <div><dt>{t("Python 来源")}</dt><dd>{selected.source}</dd></div>
          <div><dt>{t("Web 交互")}</dt><dd>{t(selected.interaction)}</dd></div>
          <div><dt>{t("优先级")}</dt><dd>{selected.priority}</dd></div>
        </dl>
        <div className="migration-principle">
          <IconCheck size={16} />
          <span>{t("所有执行仍通过固定命令或专用本地 API，不开放任意 Shell。")}</span>
        </div>
      </aside>
    </div>
  );
}

export function ToolLabView({ commands, onOpenCommand, onError, onNotice, onNavigateDataset }) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState("atlas");
  const [side, setSide] = useState("src");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const toolCommands = commands.filter((command) => (
    ["video", "dataset", "sort", "mask"].includes(command.category)
  ));

  return (
    <section className="tool-lab-view">
      <header className="operation-header tool-lab-header">
        <div>
          <h2>{t("工具实验室")}</h2>
          <p>{t("把 DeepFaceLab 原生窗口与 Python 工具重组为可审查、可恢复的本地 Web 工作台。")}</p>
        </div>
        {activeTab === "atlas" && (
          <div className="tool-lab-actions">
            <div className="side-switch" role="group" aria-label={t("数据集") }>
              {["src", "dst"].map((value) => (
                <button className={side === value ? "is-active" : ""} key={value} type="button" onClick={() => setSide(value)}>
                  {value.toUpperCase()}
                </button>
              ))}
            </div>
            <button className="button primary" type="button" onClick={() => setRefreshVersion((value) => value + 1)}>
              <IconRefresh size={15} />{t("刷新分析")}
            </button>
          </div>
        )}
      </header>

      <nav className="tool-lab-tabs" aria-label={t("工具实验室视图") }>
        <button className={activeTab === "atlas" ? "is-active" : ""} type="button" onClick={() => setActiveTab("atlas")}>
          <IconFileAnalytics size={16} />{t("人脸姿态图谱")}
        </button>
        <button className={activeTab === "migration" ? "is-active" : ""} type="button" onClick={() => setActiveTab("migration")}>
          <IconRoute size={16} />{t("工具迁移地图")}
        </button>
        <button className={activeTab === "commands" ? "is-active" : ""} type="button" onClick={() => setActiveTab("commands")}>
          <IconCode size={16} />{t("命令目录")}
        </button>
      </nav>

      <div className="tool-lab-content">
        {activeTab === "atlas" ? (
          <PoseAtlas
            side={side}
            refreshVersion={refreshVersion}
            onError={onError}
            onNotice={onNotice}
            onNavigateDataset={onNavigateDataset}
            onOpenCommand={onOpenCommand}
          />
        ) : activeTab === "migration" ? (
          <MigrationMap />
        ) : (
          <div className="tool-command-catalog">
            <header>
              <div><h3>{t("固定白名单工具")}</h3><p>{t("运行时不会读取 BAT；每个入口都由服务端固定 executable 与参数边界。")}</p></div>
              <span>{t("{count} 个命令", { count: toolCommands.length })}</span>
            </header>
            <CommandRows commands={toolCommands} onOpenCommand={onOpenCommand} />
          </div>
        )}
      </div>
    </section>
  );
}
