import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconAlertTriangle,
  IconArchive,
  IconArrowLeft,
  IconArrowRight,
  IconBoxModel2,
  IconCheck,
  IconCopy,
  IconDeviceFloppy,
  IconPhoto,
  IconPlayerPlay,
  IconRefresh,
  IconRestore,
  IconRotateClockwise,
  IconShieldCheck,
  IconSparkles,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { runtimeApi } from "../runtime/api.js";
import { useI18n } from "../i18n.jsx";
import { LoadingProgress } from "./ProgressFeedback.jsx";

const categoryLabels = {
  dataset: "数据集工具",
  encode: "视频封装",
  extract: "提取",
  mask: "XSeg 遮罩",
  merge: "模型应用",
  model: "模型导出",
  sort: "排序清洗",
  training: "模型训练",
  video: "视频处理",
};

const terminalStates = new Set(["succeeded", "failed", "cancelled", "orphaned"]);

function profileLabel(profile) {
  return profile === "legacy" ? "DFL legacy" : "DFL current";
}

export function CommandRows({ commands, onOpenCommand }) {
  const { t } = useI18n();
  const groups = useMemo(() => {
    const result = new Map();
    for (const command of commands) {
      const key = command.category ?? "other";
      if (!result.has(key)) result.set(key, []);
      result.get(key).push(command);
    }
    return [...result.entries()];
  }, [commands]);

  if (!commands.length) {
    return <div className="operation-empty">{t("当前分区没有可运行的源码命令。")}</div>;
  }

  return (
    <div className="command-groups">
      {groups.map(([category, items]) => (
        <section className="command-group" key={category}>
          <header>
            <h3>{t(categoryLabels[category] ?? category)}</h3>
            <span>{t("{count} 项", { count: items.length })}</span>
          </header>
          <div className="command-rows">
            {items.map((command) => (
              <button
                className="command-row"
                key={command.id}
                type="button"
                onClick={() => onOpenCommand(command.id)}
              >
                <span className="command-row-state"><IconPlayerPlay size={15} /></span>
                <span className="command-row-copy">
                  <strong>{command.label}</strong>
                  <small>{command.description}</small>
                </span>
                <span className="command-row-meta">
                  <span>{profileLabel(command.profile)}</span>
                  <span>{t("{count} 个参数", { count: command.parameters?.length ?? 0 })}</span>
                </span>
                <IconArrowRight size={17} />
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function CommandCenterView({
  title,
  description,
  commands,
  filter,
  onOpenCommand,
  aside,
}) {
  const { t } = useI18n();
  const visibleCommands = useMemo(
    () => commands.filter(filter),
    [commands, filter],
  );
  return (
    <section className="operation-view">
      <header className="operation-header">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span className="operation-count">{t("{count} 个已接入功能", { count: visibleCommands.length })}</span>
      </header>
      <div className={`operation-layout ${aside ? "has-aside" : ""}`}>
        <CommandRows commands={visibleCommands} onOpenCommand={onOpenCommand} />
        {aside}
      </div>
    </section>
  );
}

function imagePoint(svg, event, width, height) {
  const rect = svg.getBoundingClientRect();
  return [
    Math.max(0, Math.min(width, ((event.clientX - rect.left) / rect.width) * width)),
    Math.max(0, Math.min(height, ((event.clientY - rect.top) / rect.height) * height)),
  ];
}

function AnnotationCanvas({
  side,
  item,
  annotation,
  clipboard,
  onClipboardChange,
  onNavigate,
  onLoadPrevious,
  onDirtyChange,
  onSaved,
  onError,
}) {
  const { t } = useI18n();
  const svgRef = useRef(null);
  const [polygons, setPolygons] = useState([]);
  const [draft, setDraft] = useState([]);
  const [polygonType, setPolygonType] = useState("include");
  const [saving, setSaving] = useState(false);
  const [loadingPrevious, setLoadingPrevious] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [showAppliedMask, setShowAppliedMask] = useState(true);
  const baselineRef = useRef("[]");

  useEffect(() => {
    const nextPolygons = annotation?.polygons ?? [];
    setPolygons(nextPolygons);
    baselineRef.current = JSON.stringify(nextPolygons);
    onDirtyChange(false);
    setDraft([]);
    setDragging(null);
  }, [annotation, onDirtyChange]);

  useEffect(() => {
    onDirtyChange(JSON.stringify(polygons) !== baselineRef.current || draft.length > 0);
  }, [draft.length, onDirtyChange, polygons]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!annotation) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
      const key = event.key.toLocaleLowerCase();
      if (event.ctrlKey && key === "s") { event.preventDefault(); void save(); return; }
      if (event.ctrlKey && key === "c") { event.preventDefault(); copyPolygons(); return; }
      if (event.ctrlKey && key === "v") { event.preventDefault(); pastePolygons(); return; }
      if (key === "q") setPolygonType("include");
      else if (key === "w") setPolygonType("exclude");
      else if (key === "g") importSuggested();
      else if (event.key === "ArrowLeft") onNavigate(-1);
      else if (event.key === "ArrowRight") onNavigate(1);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  if (!annotation) {
    return (
      <div className="asset-detail-loading">
        <LoadingProgress
          tone="violet"
          label={t("正在读取 DFL 标注元数据…")}
          detail={t("正在加载多边形、应用遮罩与建议轮廓")}
        />
      </div>
    );
  }

  const addPoint = (event) => {
    if (dragging || event.button !== 0) return;
    const svg = svgRef.current;
    if (!svg) return;
    setDraft((current) => [
      ...current,
      imagePoint(svg, event, annotation.width, annotation.height),
    ]);
  };

  const finishPolygon = () => {
    if (draft.length < 3) {
      onError(new Error(t("至少需要 3 个点才能闭合多边形")));
      return;
    }
    setPolygons((current) => [...current, { type: polygonType, points: draft }]);
    setDraft([]);
  };

  const movePoint = (event) => {
    if (!dragging || !svgRef.current) return;
    const point = imagePoint(svgRef.current, event, annotation.width, annotation.height);
    setPolygons((current) => current.map((polygon, polygonIndex) => (
      polygonIndex !== dragging.polygonIndex
        ? polygon
        : {
          ...polygon,
          points: polygon.points.map((candidate, pointIndex) => (
            pointIndex === dragging.pointIndex ? point : candidate
          )),
        }
    )));
  };

  const save = async () => {
    setSaving(true);
    try {
      const result = await runtimeApi.saveAlignedAnnotation(side, item.name, polygons);
      baselineRef.current = JSON.stringify(polygons);
      onDirtyChange(false);
      onSaved(result);
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
    }
  };

  const copyPolygons = () => {
    onClipboardChange(structuredClone(polygons));
  };

  const pastePolygons = () => {
    if (Array.isArray(clipboard) && clipboard.length) setPolygons(structuredClone(clipboard));
  };

  const inheritPrevious = async () => {
    setLoadingPrevious(true);
    try {
      const previous = await onLoadPrevious();
      if (previous?.polygons?.length) setPolygons(structuredClone(previous.polygons));
      else onError(new Error(t("上一张没有可继承的多边形标注")));
    } catch (error) {
      onError(error);
    } finally {
      setLoadingPrevious(false);
    }
  };

  const importSuggested = () => {
    if (!annotation.suggestedPolygons?.length) return;
    setPolygons(structuredClone(annotation.suggestedPolygons));
  };

  const colors = {
    include: { stroke: "#42d89a", fill: "rgba(52, 211, 153, 0.22)" },
    exclude: { stroke: "#ff7a7a", fill: "rgba(255, 92, 92, 0.18)" },
  };

  return (
    <div className="annotation-editor">
      <div className="annotation-toolbar">
        <div className="seg-type-switch" aria-label={t("多边形类型")}>
          <button
            className={polygonType === "include" ? "is-active" : ""}
            type="button"
            onClick={() => setPolygonType("include")}
          >
            <span className="seg-swatch include" />{t("保留区")}
          </button>
          <button
            className={polygonType === "exclude" ? "is-active" : ""}
            type="button"
            onClick={() => setPolygonType("exclude")}
          >
            <span className="seg-swatch exclude" />{t("排除区")}
          </button>
        </div>
        <div className="annotation-actions">
          <button className="button secondary" type="button" onClick={() => void inheritPrevious()} disabled={loadingPrevious || saving}>
            <IconCopy size={15} />{t("继承上一张")}
          </button>
          <button className="button secondary" type="button" onClick={copyPolygons} disabled={!polygons.length} title="Ctrl+C">{t("复制")}</button>
          <button className="button secondary" type="button" onClick={pastePolygons} disabled={!clipboard?.length} title="Ctrl+V">{t("粘贴")}</button>
          <button className={`button secondary ${showAppliedMask ? "is-active" : ""}`} type="button" onClick={() => setShowAppliedMask((value) => !value)} disabled={!annotation.appliedMaskDataUrl}>{t("遮罩叠加")}</button>
          <button className="button secondary" type="button" onClick={importSuggested} disabled={!annotation.suggestedPolygons?.length} title="G">
            <IconSparkles size={15} />{t("导入遮罩轮廓")}
          </button>
          <button className="button secondary" type="button" onClick={() => setDraft((value) => value.slice(0, -1))} disabled={!draft.length}>
            <IconRotateClockwise size={15} />{t("撤销点")}
          </button>
          <button className="button secondary" type="button" onClick={finishPolygon} disabled={draft.length < 3}>
            <IconCheck size={15} />{t("闭合")}
          </button>
          <button className="button secondary" type="button" onClick={() => setPolygons((value) => value.slice(0, -1))} disabled={!polygons.length}>
            <IconTrash size={15} />{t("移除末项")}
          </button>
          <button className="button primary" type="button" onClick={() => void save()} disabled={saving || loadingPrevious || draft.length > 0}>
            <IconDeviceFloppy size={15} />{saving ? t("保存中") : t("写入 JPG")}
          </button>
        </div>
      </div>
      {saving || loadingPrevious ? (
        <LoadingProgress
          compact
          tone="violet"
          className="annotation-progress"
          label={saving ? t("正在保存 XSeg 标注…") : t("正在读取上一张标注…")}
          detail={saving ? t("正在原子写回 DFL JPG 元数据") : t("当前编辑内容保持不变")}
        />
      ) : null}
      <div className="annotation-canvas-wrap">
        <svg
          ref={svgRef}
          className="annotation-canvas"
          viewBox={`0 0 ${annotation.width} ${annotation.height}`}
          role="img"
          aria-label={t("{name} XSeg 多边形编辑器", { name: item.name })}
          onPointerDown={addPoint}
          onPointerMove={movePoint}
          onPointerUp={() => setDragging(null)}
          onPointerCancel={() => setDragging(null)}
        >
          <image
            href={item.imageUrl}
            x="0"
            y="0"
            width={annotation.width}
            height={annotation.height}
            preserveAspectRatio="none"
          />
          {showAppliedMask && annotation.appliedMaskDataUrl ? (
            <image
              className="annotation-mask-overlay"
              href={annotation.appliedMaskDataUrl}
              x="0"
              y="0"
              width={annotation.width}
              height={annotation.height}
              opacity="0.42"
              preserveAspectRatio="none"
              pointerEvents="none"
            />
          ) : null}
          {polygons.map((polygon, polygonIndex) => (
            <g key={`${polygon.type}-${polygonIndex}`}>
              <polygon
                points={polygon.points.map((point) => point.join(",")).join(" ")}
                stroke={colors[polygon.type].stroke}
                fill={colors[polygon.type].fill}
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
              {polygon.points.map((point, pointIndex) => (
                <circle
                  key={`${polygonIndex}-${pointIndex}`}
                  className="annotation-handle"
                  cx={point[0]}
                  cy={point[1]}
                  r="4"
                  fill={colors[polygon.type].stroke}
                  stroke="#07110e"
                  strokeWidth="1.5"
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDragging({ polygonIndex, pointIndex });
                  }}
                />
              ))}
            </g>
          ))}
          {draft.length > 0 && (
            <g>
              <polyline
                points={draft.map((point) => point.join(",")).join(" ")}
                stroke={colors[polygonType].stroke}
                fill="none"
                strokeWidth="2"
                strokeDasharray="7 5"
                vectorEffect="non-scaling-stroke"
              />
              {draft.map((point, index) => (
                <circle
                  key={`draft-${index}`}
                  cx={point[0]}
                  cy={point[1]}
                  r="4"
                  fill={colors[polygonType].stroke}
                />
              ))}
            </g>
          )}
        </svg>
      </div>
      <p className="annotation-help">
        {t("点击图片添加点，闭合后可拖动顶点微调。红色“排除区”会从绿色“保留区”中扣除；保存会直接更新 DFL JPG 元数据。")}
      </p>
    </div>
  );
}

export function DatasetView({
  side,
  commands,
  focusItem,
  focusNonce,
  onFocusConsumed,
  onOpenCommand,
  onError,
  onNotice,
  editMasks = false,
  onSideChange,
}) {
  const { t } = useI18n();
  const [assets, setAssets] = useState(null);
  const [quarantine, setQuarantine] = useState([]);
  const [selectedName, setSelectedName] = useState(null);
  const [annotation, setAnnotation] = useState(null);
  const [loading, setLoading] = useState(true);
  const [datasetAction, setDatasetAction] = useState(null);
  const [maskClipboard, setMaskClipboard] = useState([]);
  const [maskDirty, setMaskDirty] = useState(false);
  const handleMaskDirty = useCallback((value) => setMaskDirty(value), []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [nextAssets, nextQuarantine] = await Promise.all([
        runtimeApi.alignedAssets(side, { limit: 200 }),
        runtimeApi.alignedQuarantine(side),
      ]);
      setAssets(nextAssets);
      setQuarantine(nextQuarantine);
      setSelectedName((current) => (
        current && nextAssets.items.some((item) => item.name === current)
          ? current
          : nextAssets.items[0]?.name ?? null
      ));
    } catch (error) {
      onError(error);
    } finally {
      setLoading(false);
    }
  }, [onError, side]);

  useEffect(() => {
    setAssets(null);
    setSelectedName(null);
    setAnnotation(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!focusItem || !focusNonce || !assets || assets.side !== side) return;
    setAssets((current) => {
      if (!current || current.items.some((item) => item.name === focusItem.name)) return current;
      return { ...current, items: [focusItem, ...current.items] };
    });
    setSelectedName(focusItem.name);
    onFocusConsumed?.();
  }, [assets, focusItem, focusNonce, onFocusConsumed, side]);

  useEffect(() => {
    if (
      !selectedName
      || !editMasks
      || assets?.side !== side
      || !assets.items.some((item) => item.name === selectedName)
    ) {
      setAnnotation(null);
      return;
    }
    let cancelled = false;
    setAnnotation(null);
    void runtimeApi.alignedAnnotation(side, selectedName)
      .then((value) => {
        if (!cancelled) setAnnotation(value);
      })
      .catch(onError);
    return () => {
      cancelled = true;
    };
  }, [assets, editMasks, onError, selectedName, side]);

  const selected = assets?.items.find((item) => item.name === selectedName) ?? null;
  const selectedIndex = selected ? assets.items.findIndex((item) => item.name === selected.name) : -1;
  const confirmDiscardMask = () => !maskDirty || window.confirm(t("当前 XSeg 标注尚未保存，确定放弃修改并切换吗？"));
  const selectAsset = (name) => {
    if (!confirmDiscardMask()) return;
    setSelectedName(name);
    setMaskDirty(false);
  };
  const navigateAsset = (direction) => {
    if (!assets?.items.length || !confirmDiscardMask()) return;
    const nextIndex = Math.min(Math.max(selectedIndex + direction, 0), assets.items.length - 1);
    setSelectedName(assets.items[nextIndex].name);
    setMaskDirty(false);
  };
  const loadPreviousAnnotation = async () => {
    if (!assets?.items.length || selectedIndex <= 0) return null;
    return runtimeApi.alignedAnnotation(side, assets.items[selectedIndex - 1].name);
  };
  const sideCommands = commands.filter((command) => (
    command.side === side
    && (command.category === "dataset" || command.category === "extract" || command.category === "sort")
  ));

  const quarantineSelected = async () => {
    if (!selected || !window.confirm(t("把 {name} 移入可恢复隔离区吗？", { name: selected.name }))) return;
    setDatasetAction("quarantine");
    try {
      await runtimeApi.quarantineAligned(side, selected.name);
      onNotice(t("{name} 已移入隔离区，可随时恢复", { name: selected.name }));
      await refresh();
    } catch (error) {
      onError(error);
    } finally {
      setDatasetAction(null);
    }
  };

  const restore = async (item) => {
    setDatasetAction(`restore:${item.token}`);
    try {
      await runtimeApi.restoreAligned(side, item.token, item.name);
      onNotice(t("{name} 已恢复到 {side} aligned", { name: item.name, side: side.toUpperCase() }));
      await refresh();
    } catch (error) {
      onError(error);
    } finally {
      setDatasetAction(null);
    }
  };

  return (
    <section className="dataset-view">
      <header className="operation-header dataset-header">
        <div>
          <h2>{editMasks ? t("XSeg Web 遮罩编辑器") : t("{side} 数据集", { side: side.toUpperCase() })}</h2>
          <p>
            {editMasks
              ? t("在浏览器中直接读写 DFL aligned JPG 的 include / exclude 多边形。")
              : t("浏览 aligned 人脸、检查元数据，并通过可恢复隔离完成素材清洗。")}
          </p>
        </div>
        <div className="dataset-header-actions">
          {editMasks && (
            <div className="side-switch">
              {["src", "dst"].map((value) => (
                <button
                  className={side === value ? "is-active" : ""}
                  key={value}
                  type="button"
                  onClick={() => { if (confirmDiscardMask()) { setMaskDirty(false); onSideChange(value); } }}
                >
                  {value.toUpperCase()}
                </button>
              ))}
            </div>
          )}
          <button className="button secondary" type="button" onClick={() => void refresh()} disabled={loading}>
            <IconRefresh size={15} />{loading ? t("扫描中") : t("刷新")}
          </button>
        </div>
      </header>
      {datasetAction ? (
        <LoadingProgress
          compact
          tone={editMasks ? "violet" : "green"}
          label={datasetAction === "quarantine" ? t("正在隔离样本…") : t("正在恢复样本…")}
          detail={t("完成后会重新扫描当前数据集")}
        />
      ) : loading ? (
        <LoadingProgress
          compact
          tone={editMasks ? "violet" : "green"}
          label={assets ? t("正在刷新 aligned 数据集…") : t("正在扫描 aligned 数据集…")}
          detail={t("正在读取样本与可恢复隔离区")}
        />
      ) : null}

      {!editMasks && sideCommands.length > 0 && (
        <div className="dataset-command-strip">
          {sideCommands.slice(0, 6).map((command) => (
            <button type="button" key={command.id} onClick={() => onOpenCommand(command.id)}>
              <IconPlayerPlay size={14} />{command.shortLabel}
            </button>
          ))}
          <span>{t("{count} 个数据集命令已接入", { count: sideCommands.length })}</span>
        </div>
      )}

      <div className="dataset-layout">
        <aside className="asset-browser">
          <div className="asset-browser-heading">
            <div>
              <IconPhoto size={18} />
              <strong>{t("aligned 人脸")}</strong>
            </div>
            <span>{assets?.total ?? 0}</span>
          </div>
          <div className="asset-thumbnails">
            {assets?.items.map((item) => (
              <button
                className={`asset-thumbnail ${selectedName === item.name ? "is-active" : ""}`}
                key={item.name}
                type="button"
                onClick={() => selectAsset(item.name)}
                title={item.sourceFilename ?? item.name}
              >
                <img src={item.imageUrl} alt="" loading="lazy" decoding="async" />
                <span>{item.name}</span>
                <small>
                  {item.polygonCount
                    ? t("{count} 个标注", { count: item.polygonCount })
                    : item.hasAppliedMask ? t("已有应用遮罩") : t("未标注")}
                </small>
              </button>
            ))}
            {!loading && !assets?.items.length && (
              <div className="asset-browser-empty">{t("尚未生成 aligned JPG。")}</div>
            )}
          </div>
          <div className="asset-browser-pager">
            <button type="button" disabled><IconArrowLeft size={15} />{t("上一页")}</button>
            <span>{assets?.total ? `1–${assets.items.length} / ${assets.total}` : "0 / 0"}</span>
            <button type="button" disabled={assets?.items.length >= assets?.total}>{t("下一页")}<IconArrowRight size={15} /></button>
          </div>
        </aside>

        <section className="asset-detail">
          {selected ? (
            <>
              <header className="asset-detail-heading">
                <div>
                  <strong>{selected.name}</strong>
                  <small>{selected.sourceFilename ?? t("没有源文件名元数据")}</small>
                </div>
                {!editMasks && (
                  <button className="button danger" type="button" onClick={() => void quarantineSelected()} disabled={Boolean(datasetAction)}>
                    <IconArchive size={15} />{t("隔离")}
                  </button>
                )}
              </header>
              {editMasks ? (
                <AnnotationCanvas
                  side={side}
                  item={selected}
                  annotation={annotation}
                  clipboard={maskClipboard}
                  onClipboardChange={setMaskClipboard}
                  onNavigate={navigateAsset}
                  onLoadPrevious={loadPreviousAnnotation}
                  onDirtyChange={handleMaskDirty}
                  onError={onError}
                  onSaved={(result) => {
                    onNotice(t("已写入 {count} 个多边形标注", { count: result.polygonCount }));
                    void refresh();
                  }}
                />
              ) : (
                <div className="asset-inspector">
                  <img src={selected.imageUrl} alt={t("{name} aligned 人脸", { name: selected.name })} decoding="async" />
                  <dl>
                    <div><dt>{t("DFL 元数据")}</dt><dd>{selected.hasDflMetadata ? t("有效") : t("无效")}</dd></div>
                    <div><dt>{t("手绘多边形")}</dt><dd>{selected.polygonCount}</dd></div>
                    <div><dt>{t("标注点")}</dt><dd>{selected.pointCount}</dd></div>
                    <div><dt>{t("应用遮罩")}</dt><dd>{selected.hasAppliedMask ? t("已写入") : t("未写入")}</dd></div>
                  </dl>
                </div>
              )}
            </>
          ) : (
            <div className="asset-detail-empty"><IconPhoto size={28} />{t("选择一张 aligned 人脸查看。")}</div>
          )}
        </section>
      </div>

      {quarantine.length > 0 && (
        <section className="quarantine-section">
          <header>
            <div>
              <IconShieldCheck size={18} />
              <h3>{t("可恢复隔离区")}</h3>
            </div>
            <span>{t("{count} 项", { count: quarantine.length })}</span>
          </header>
          <div className="quarantine-rows">
            {quarantine.map((item) => (
              <div key={`${item.token}-${item.name}`}>
                <span>{item.name}</span>
                <small>{item.token.slice(0, 8)} {item.token.slice(8, 14)}</small>
                <button className="button secondary" type="button" onClick={() => void restore(item)} disabled={Boolean(datasetAction)}>
                  <IconRestore size={15} />{t("恢复")}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}

export function ModelSummaryAside({ workspace }) {
  const { t } = useI18n();
  if (!workspace) {
    return (
      <aside className="model-summary-aside">
        <LoadingProgress compact label={t("正在读取模型目录…")} detail={t("正在核对模型家族与文件状态")} />
      </aside>
    );
  }
  return (
    <aside className="model-summary-aside">
      <div className="model-summary-heading">
        <IconBoxModel2 size={19} />
        <h3>{t("已检测模型")}</h3>
      </div>
      {workspace?.models?.length ? workspace.models.map((model) => (
        <div className="model-summary-row" key={`${model.type}-${model.name}`}>
          <span>{model.type}</span>
          <div>
            <strong>{model.name}</strong>
            <small>{t("{count} 个文件", { count: model.fileCount })}</small>
          </div>
        </div>
      )) : (
        <div className="model-empty-guide">
          <strong>{t("还没有可用模型")}</strong>
          <span>{t("首次使用可从“训练 SAEHD”开始。")}</span>
          <small>{t("训练生成的模型文件会自动出现在这里。")}</small>
        </div>
      )}
    </aside>
  );
}

export function SettingsView({ health, jobs, onRetry, onError, onNotice }) {
  const { t } = useI18n();
  const [projects, setProjects] = useState(null);
  const [projectName, setProjectName] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectBusy, setProjectBusy] = useState(null);
  const [retryBusy, setRetryBusy] = useState(null);
  useEffect(() => {
    let cancelled = false;
    void runtimeApi.projects().then((value) => { if (!cancelled) setProjects(value); }).catch(onError);
    return () => { cancelled = true; };
  }, [onError]);
  const recoverable = jobs.filter((job) => terminalStates.has(job.state));
  const activeJobCount = jobs.filter((job) => ["queued", "starting", "running", "waiting_input", "stopping"].includes(job.state)).length;
  const createProject = async () => {
    setProjectBusy("create");
    try {
      await runtimeApi.createProject({ name: projectName, id: projectId });
      setProjects(await runtimeApi.projects());
      setProjectName("");
      setProjectId("");
      onNotice(t("新项目已创建；可在任务停止后切换。"));
    } catch (error) { onError(error); } finally { setProjectBusy(null); }
  };
  const activateProject = async (id, name) => {
    if (!window.confirm(t("切换到项目“{name}”吗？本地服务会重启，当前页面随后自动刷新。", { name }))) return;
    setProjectBusy("activate");
    try {
      const result = await runtimeApi.activateProject(id);
      if (!result.restartRequired) {
        setProjectBusy(null);
        return;
      }
      onNotice(t("正在切换项目并重启本地服务…"));
      window.setTimeout(() => window.location.reload(), 1600);
    } catch (error) { setProjectBusy(null); onError(error); }
  };
  return (
    <section className="operation-view settings-view">
      <header className="operation-header">
        <div>
          <h2>{t("运行时与恢复")}</h2>
          <p>{t("检查固定执行环境，并从已结束或服务重启后失联的任务重新创建安全副本。")}</p>
        </div>
        <span className="operation-count">{health?.loopbackOnly ? t("仅本机访问") : t("状态未知")}</span>
      </header>
      {!projects ? (
        <LoadingProgress compact label={t("正在读取受管项目…")} detail={t("正在确认当前工作区与切换安全性")} />
      ) : projectBusy ? (
        <LoadingProgress
          compact
          tone={projectBusy === "activate" ? "amber" : "green"}
          label={projectBusy === "activate" ? t("正在切换项目并重启本地服务…") : t("正在创建受管项目…")}
          detail={projectBusy === "activate" ? t("当前页面会在服务恢复后自动刷新") : t("新项目只会写入受管工作区目录")}
        />
      ) : retryBusy ? (
        <LoadingProgress compact label={t("正在从历史记录创建安全副本…")} detail={retryBusy} />
      ) : null}
      <div className="settings-runtime">
        {["current", "legacy"].map((profile) => (
          <section key={profile}>
            <span>{profileLabel(profile)}</span>
            <strong>{health?.runtime?.[profile]?.dflRoot ?? t("未检测")}</strong>
            <code>{health?.runtime?.[profile]?.python ?? t("Python 未检测")}</code>
          </section>
        ))}
        <section>
          <span>{t("安全边界")}</span>
          <strong>{t("固定命令注册表 + ConPTY")}</strong>
          <code>{t("不执行、不解析 BAT；写操作需要本机会话")}</code>
        </section>
      </div>
      <section className="project-manager-section">
        <header>
          <div><IconBoxModel2 size={19} /><div><h3>{t("受管项目工作区")}</h3><p>{t("每个项目独立保存素材、模型、任务日志、诊断与恢复记录。")}</p></div></div>
          <span className={activeJobCount ? "is-warning" : "is-ok"}>{activeJobCount ? t("{count} 个任务阻止切换", { count: activeJobCount }) : t("可以安全切换")}</span>
        </header>
        <div className="project-manager-grid">
          <div className="project-list">
            {projects?.projects.map((project) => (
              <article className={project.active ? "is-active" : ""} key={project.id}>
                <span>{project.active ? <IconCheck size={15} /> : <IconBoxModel2 size={15} />}</span>
                <div><strong>{project.name}</strong><small>{project.id} · {project.managed ? t("受管目录") : t("兼容默认工作区")}</small></div>
                <button className="button secondary" type="button" disabled={project.active || activeJobCount > 0 || projectBusy} onClick={() => void activateProject(project.id, project.name)}>{project.active ? t("当前") : t("切换")}</button>
              </article>
            ))}
            {!projects ? <div className="operation-empty">{t("项目清单准备中")}</div> : null}
          </div>
          <form className="project-create-form" onSubmit={(event) => { event.preventDefault(); void createProject(); }}>
            <strong>{t("新建项目")}</strong>
            <label><span>{t("项目名称")}</span><input value={projectName} maxLength={64} onChange={(event) => setProjectName(event.target.value)} placeholder={t("例如：访谈片 A")}/></label>
            <label><span>{t("项目标识")}</span><input value={projectId} maxLength={48} onChange={(event) => setProjectId(event.target.value)} placeholder="interview-a" /></label>
            <small>{t("仅在仓库的 workspaces 目录中创建，不接受任意磁盘路径。创建不会自动切换。")}</small>
            <button className="button primary" type="submit" disabled={!projectName.trim() || !projectId.trim() || projectBusy}>{projectBusy ? t("处理中…") : t("创建受管项目")}</button>
          </form>
        </div>
      </section>
      <section className="recovery-section">
        <header>
          <div>
            <IconRestore size={19} />
            <h3>{t("任务恢复")}</h3>
          </div>
          <span>{t("{count} 个可重试记录", { count: recoverable.length })}</span>
        </header>
        <div className="recovery-rows">
          {recoverable.slice(0, 20).map((job) => (
            <div key={job.id}>
              <span className={`recovery-state is-${job.state}`}>
                {job.state === "orphaned" ? <IconAlertTriangle size={15} /> : <IconCheck size={15} />}
              </span>
              <div>
                <strong>{job.label}</strong>
                <small>{job.id} · {job.state}</small>
              </div>
              <button
                className="button secondary"
                type="button"
                onClick={async () => {
                  setRetryBusy(job.id);
                  try {
                    const next = await onRetry(job.id);
                    onNotice(t("已从 {source} 创建新任务 {target}", { source: job.id, target: next.id }));
                  } catch (error) {
                    onError(error);
                  } finally {
                    setRetryBusy(null);
                  }
                }}
                disabled={Boolean(retryBusy) || Boolean(projectBusy)}
              >
                <IconRefresh size={15} />{t("重试")}
              </button>
            </div>
          ))}
          {!recoverable.length && <div className="operation-empty">{t("没有可恢复的历史任务。")}</div>}
        </div>
      </section>
      <section className="deferred-section">
        <IconX size={18} />
        <div>
          <strong>{t("本轮明确不接入")}</strong>
          <p>{t("独立闭源 EXE、EBSynth 与第三方角度工具保持外部运行；不会在 Web 中伪造控制或状态。")}</p>
        </div>
      </section>
    </section>
  );
}
