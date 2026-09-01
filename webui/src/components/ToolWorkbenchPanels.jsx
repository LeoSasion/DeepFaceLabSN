import { useEffect, useMemo, useState } from "react";
import {
  IconAlertTriangle,
  IconArchive,
  IconArrowRight,
  IconCheck,
  IconChevronLeft,
  IconChevronRight,
  IconCode,
  IconFilter,
  IconMask,
  IconPhoto,
  IconPlayerPlay,
  IconRefresh,
  IconSearch,
  IconShieldCheck,
} from "@tabler/icons-react";
import { useI18n } from "../i18n.jsx";
import { runtimeApi } from "../runtime/api.js";
import { LoadingProgress } from "./ProgressFeedback.jsx";

const ISSUE_LABELS = {
  unreadable_image: "图片无法读取",
  missing_dfl_metadata: "缺少 DFL 元数据",
  low_sharpness: "清晰度偏低",
  underexposed: "曝光不足",
  overexposed: "曝光过高",
  clipped_tones: "高光或暗部截断",
  mask_invalid: "应用遮罩无有效区域",
  mask_missing: "尚无应用遮罩",
  duplicate_source: "同源人脸重复",
};
const AUDIT_PAGE_SIZE = 120;
const REVIEW_PAGE_SIZE = 60;

function percent(value) {
  return `${Math.round((Number(value) || 0) * 100)}%`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function LoadingState({ label }) {
  const { t } = useI18n();
  return (
    <div className="tool-workbench-state is-loading">
      <LoadingProgress inline className="in-panel" label={label} detail={t("仅在本地读取与分析，不会调用外部服务")} />
    </div>
  );
}

function ErrorState({ error, onRetry }) {
  const { t } = useI18n();
  return (
    <div className="tool-workbench-state is-error">
      <IconAlertTriangle size={24} />
      <strong>{t("工作台数据未能载入")}</strong>
      <span>{t(error?.message ?? "本地分析失败")}</span>
      <button className="button secondary" type="button" onClick={onRetry}>
        <IconRefresh size={15} />{t("重试")}
      </button>
    </div>
  );
}

function CompactSummary({ children }) {
  return <div className="tool-compact-summary">{children}</div>;
}

function AuditMetric({ label, value, display, detail, tone = "default" }) {
  return (
    <div className={`audit-metric is-${tone}`}>
      <div><span>{label}</span><strong>{display}</strong></div>
      <i aria-hidden="true"><b style={{ width: percent(value) }} /></i>
      {detail && <small>{detail}</small>}
    </div>
  );
}

export function DatasetAuditPanel({
  side,
  refreshVersion,
  onError,
  onNotice,
  onNavigateDataset,
  onOpenCommand,
}) {
  const { t } = useI18n();
  const [audit, setAudit] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const [issue, setIssue] = useState("all");
  const [maskFilter, setMaskFilter] = useState("all");
  const [sort, setSort] = useState("quality");
  const [query, setQuery] = useState("");
  const [selectedName, setSelectedName] = useState(null);
  const [offset, setOffset] = useState(0);
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => setOffset(0), [side]);

  useEffect(() => {
    let cancelled = false;
    setAudit(null);
    setError(null);
    void runtimeApi.alignedAudit(side, {
      refresh: refreshVersion > 0 || retry > 0,
      offset,
      limit: AUDIT_PAGE_SIZE,
    })
      .then((value) => {
        if (cancelled) return;
        setAudit(value);
        setSelectedName((current) => (
          value.items.some((item) => item.name === current) ? current : value.items[0]?.name ?? null
        ));
      })
      .catch((nextError) => {
        if (cancelled) return;
        setError(nextError);
        onError(nextError);
      });
    return () => { cancelled = true; };
  }, [offset, onError, refreshVersion, retry, side]);

  const visibleItems = useMemo(() => {
    if (!audit) return [];
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const filtered = audit.items.filter((item) => {
      if (issue !== "all" && !item.issues.includes(issue)) return false;
      if (maskFilter === "xseg" && !item.hasAppliedMask) return false;
      if (maskFilter === "none" && item.hasAppliedMask) return false;
      if (normalizedQuery && !`${item.name} ${item.sourceFilename ?? ""}`.toLocaleLowerCase().includes(normalizedQuery)) return false;
      return true;
    });
    return filtered.slice().sort((left, right) => {
      if (sort === "name") return left.name.localeCompare(right.name, undefined, { numeric: true });
      if (sort === "brightness") return (left.brightness ?? -1) - (right.brightness ?? -1);
      if (sort === "sharpness") return (left.sharpness ?? -1) - (right.sharpness ?? -1);
      return (left.qualityScore ?? -1) - (right.qualityScore ?? -1);
    });
  }, [audit, issue, maskFilter, query, sort]);
  const selected = visibleItems.find((item) => item.name === selectedName) ?? visibleItems[0] ?? null;
  const selectedIndex = selected ? visibleItems.findIndex((item) => item.name === selected.name) : -1;
  const exposureScore = selected
    ? Math.max(0, 1 - Math.abs((selected.brightness ?? 0) - 0.5) / 0.5)
    : 0;

  const quarantineSelected = async () => {
    if (!selected) return;
    if (!window.confirm(t("将 {name} 移入可恢复隔离区吗？", { name: selected.name }))) return;
    setActionBusy(true);
    try {
      await runtimeApi.quarantineAligned(side, selected.name);
      onNotice(t("{name} 已移入可恢复隔离区", { name: selected.name }));
      setRetry((value) => value + 1);
    } catch (nextError) {
      onError(nextError);
    } finally {
      setActionBusy(false);
    }
  };

  if (error) return <ErrorState error={error} onRetry={() => setRetry((value) => value + 1)} />;
  if (!audit) return <LoadingState label={t("正在读取 DFL 元数据并计算质量指标…")} />;
  if (!audit.total) {
    return (
      <div className="tool-workbench-state">
        <IconPhoto size={26} />
        <strong>{t("还没有 aligned 人脸可审计")}</strong>
        <span>{t("先完成人脸提取，质量和元数据检查会自动出现。")}</span>
        <button className="button primary" type="button" onClick={() => onOpenCommand(`${side}.extract_faces`)}>
          <IconPlayerPlay size={15} />{t("打开人脸提取")}
        </button>
      </div>
    );
  }

  return (
    <div className="audit-workbench">
      {actionBusy ? (
        <LoadingProgress compact label={t("正在隔离审计样本…")} detail={t("完成后会重新计算本批质量摘要")} />
      ) : null}
      <header className="audit-ready-header">
        <div className="audit-ready-state">
          <span><IconShieldCheck size={21} /></span>
          <div><strong>{t("数据审计就绪")}</strong><small>{t("已完成本批次质量分析，可开始筛选与复核。")}</small></div>
        </div>
        <dl>
          <div><dt>{t("数据集")}</dt><dd>{side.toUpperCase()} ALIGNED</dd></div>
          <div><dt>{t("分析范围")}</dt><dd>{audit.offset + 1}–{audit.offset + audit.analyzedCount}</dd></div>
          <div><dt>{t("清晰度规则")}</dt><dd>{t("XSeg 优先")}</dd></div>
          <div><dt>{t("规则版本")}</dt><dd>v{audit.schemaVersion ?? 1}</dd></div>
        </dl>
      </header>

      <section className="audit-kpi-strip" aria-label={t("审计摘要") }>
        <div className="is-total"><span>{t("样本总量")}</span><strong>{audit.total.toLocaleString()}</strong><small>{t("本批分析 {count}", { count: audit.analyzedCount })}</small></div>
        <div className="is-usable"><span>{t("当前可用")}</span><strong>{audit.usableCount ?? 0}</strong><small>{percent((audit.usableCount ?? 0) / Math.max(audit.analyzedCount, 1))}</small></div>
        <div className="is-warning"><span>{t("发现问题")}</span><strong>{audit.issueItemCount ?? 0}</strong><small>{t("本批问题样本")}</small></div>
        <div className="is-danger"><span>{t("高风险")}</span><strong>{audit.severeIssueCount ?? 0}</strong><small>{t("需优先处理")}</small></div>
      </section>

      <div className="dataset-audit-layout">
        <section className="dataset-audit-main">
          <div className="audit-filter-bar">
            <label className="audit-search"><IconSearch size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("搜索文件名或源帧…")} aria-label={t("搜索审计样本")} /></label>
            <label><IconFilter size={14} /><span>{t("问题")}</span>
              <select aria-label={t("按问题筛选") } value={issue} onChange={(event) => setIssue(event.target.value)}>
                <option value="all">{t("全部样本")}</option>
                {Object.entries(ISSUE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{t(label)} · {audit.issueCounts[value] ?? 0}</option>
                ))}
              </select>
            </label>
            <label><IconMask size={14} /><span>{t("遮罩")}</span>
              <select aria-label={t("按遮罩状态筛选") } value={maskFilter} onChange={(event) => setMaskFilter(event.target.value)}>
                <option value="all">{t("全部遮罩状态")}</option>
                <option value="xseg">{t("已有 XSeg")}</option>
                <option value="none">{t("无 XSeg")}</option>
              </select>
            </label>
            <label><span>{t("排序")}</span>
              <select aria-label={t("审计样本排序") } value={sort} onChange={(event) => setSort(event.target.value)}>
                <option value="quality">{t("质量从低到高")}</option>
                <option value="sharpness">{t("清晰度从低到高")}</option>
                <option value="brightness">{t("亮度从低到高")}</option>
                <option value="name">{t("文件名")}</option>
              </select>
            </label>
            <div className="frame-stepper audit-pager">
              <button type="button" aria-label={t("上一批")} disabled={offset <= 0} onClick={() => setOffset((value) => Math.max(0, value - AUDIT_PAGE_SIZE))}><IconChevronLeft size={17} /></button>
              <span>{audit.total ? `${audit.offset + 1}–${audit.offset + audit.analyzedCount} / ${audit.total}` : "0 / 0"}</span>
              <button type="button" aria-label={t("下一批")} disabled={audit.offset + audit.analyzedCount >= audit.total} onClick={() => setOffset((value) => value + AUDIT_PAGE_SIZE)}><IconChevronRight size={17} /></button>
            </div>
          </div>

          <div className="audit-grid-heading"><span>{t("对齐人脸样本")}</span><small>{t("显示 {count} / {pageTotal}", { count: visibleItems.length, pageTotal: audit.analyzedCount })}</small></div>
          {visibleItems.length ? (
            <div className="audit-face-grid">
              {visibleItems.map((item) => (
                <button
                  className={selected?.name === item.name ? "is-selected" : ""}
                  key={item.name}
                  type="button"
                  onClick={() => setSelectedName(item.name)}
                  aria-pressed={selected?.name === item.name}
                >
                  <span className="audit-card-check"><IconCheck size={11} /></span>
                  <span className={`audit-card-mask ${item.hasAppliedMask ? "is-xseg" : "is-empty"}`}><IconMask size={10} />{item.hasAppliedMask ? "XSEG" : t("无遮罩")}</span>
                  <img src={item.imageUrl} alt="" loading="lazy" decoding="async" />
                  <span className="audit-card-title"><strong>{item.name}</strong><small>{(item.qualityScore ?? 0).toFixed(2)}</small></span>
                  <i className="audit-card-score"><b style={{ width: percent(item.qualityScore) }} /></i>
                  <span className="audit-card-meta"><small>{item.sourceFilename ?? t("无源帧信息")}</small>{item.issues[0] && <em>{t(ISSUE_LABELS[item.issues[0]] ?? item.issues[0])}</em>}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="tool-inline-empty"><IconCheck size={18} />{t("当前筛选下没有问题样本")}</div>
          )}
        </section>

        <aside className="tool-inspector audit-inspector">
          {selected ? (
            <>
              <header><div><span>{t("质量检查器")}</span><strong>{selected.name}</strong></div><small>{selectedIndex + 1} / {visibleItems.length}</small></header>
              <div className="audit-inspector-preview">
                <img className="tool-inspector-image" src={selected.imageUrl} alt="" decoding="async" />
                <span className={selected.hasAppliedMask ? "is-xseg" : ""}>{selected.hasAppliedMask ? t("含 XSeg 遮罩") : t("无 XSeg 遮罩")}</span>
              </div>
              <div className="audit-inspector-tabs"><strong>{t("质量报告")}</strong><span>{formatBytes(selected.bytes)}</span></div>
              <div className="audit-metric-list">
                <AuditMetric label={t("综合质量")} value={selected.qualityScore} display={(selected.qualityScore ?? 0).toFixed(3)} tone={(selected.qualityScore ?? 0) < 0.24 ? "warning" : "default"} />
                <AuditMetric label={t("清晰度")} value={selected.sharpness} display={(selected.sharpness ?? 0).toFixed(3)} detail={selected.sharpnessScope === "xseg" ? t("仅统计 XSeg 遮罩内") : t("按全图统计")} tone={(selected.sharpness ?? 0) < 0.24 ? "warning" : "default"} />
                {selected.sharpnessScope === "xseg" && <AuditMetric label={t("全图清晰度基线")} value={selected.fullSharpness} display={(selected.fullSharpness ?? 0).toFixed(3)} detail={t("用于对照，不参与模糊判定")} />}
                <AuditMetric label={t("曝光稳定度")} value={exposureScore} display={exposureScore.toFixed(3)} />
                <AuditMetric label={t("遮罩覆盖") } value={selected.maskCoverage} display={selected.hasAppliedMask ? percent(selected.maskCoverage) : "—"} detail={selected.hasAppliedMask ? t("内缩后有效像素 {count}", { count: selected.maskSamplePixels ?? 0 }) : t("本样本使用全图清晰度")} tone={selected.hasAppliedMask && !selected.maskValid ? "warning" : "xseg"} />
              </div>
              <dl className="tool-inspector-data">
                <div><dt>{t("姿态")}</dt><dd>{selected.yaw == null ? "—" : `${selected.yaw.toFixed(1)}° / ${selected.pitch.toFixed(1)}°`}</dd></div>
                <div><dt>{t("源帧")}</dt><dd title={selected.sourceFilename ?? ""}>{selected.sourceFilename ?? "—"}</dd></div>
                <div><dt>{t("遮罩判定")}</dt><dd>{selected.sharpnessScope === "xseg" ? t("XSeg 区域") : t("全图回退")}</dd></div>
              </dl>
              <div className="tool-issue-list">
                {selected.issues.length
                  ? selected.issues.map((value) => <span key={value}>{t(ISSUE_LABELS[value] ?? value)}</span>)
                  : <span className="is-ok"><IconCheck size={13} />{t("未发现规则问题")}</span>}
              </div>
            </>
          ) : <div className="tool-inline-empty">{t("选择一个样本查看详情")}</div>}
        </aside>
      </div>

      <footer className="audit-action-dock">
        <div><span><IconShieldCheck size={17} /></span><p><strong>{selected ? t("已选中 1 个样本") : t("尚未选择样本")}</strong><small>{selected ? `${selected.name} · ${selected.hasAppliedMask ? t("XSeg 区域判定") : t("全图判定")}` : t("从上方网格选择样本开始复核")}</small></p></div>
        <dl><div><dt>{t("本批问题")}</dt><dd>{audit.issueItemCount ?? 0}</dd></div><div><dt>{t("XSeg 判定")}</dt><dd>{audit.xsegSharpnessCount ?? 0}</dd></div><div><dt>{t("平均质量")}</dt><dd>{audit.meanQualityScore.toFixed(3)}</dd></div></dl>
        <div className="audit-dock-actions">
          <button type="button" disabled={!selected} onClick={() => selected && onNavigateDataset(side, selected)}><IconPhoto size={15} />{t("在数据集中查看")}</button>
          <button className="is-warning" type="button" disabled={!selected || actionBusy} onClick={() => void quarantineSelected()}><IconArchive size={15} />{t("移入隔离区")}</button>
          <button className="is-primary" type="button" onClick={() => onOpenCommand(`${side}.sort_faces`)}><IconCode size={15} />{t("打开排序命令")}<IconArrowRight size={14} /></button>
        </div>
      </footer>
    </div>
  );
}

export function ExtractionReviewPanel({ side, refreshVersion, onError, onOpenCommand }) {
  const { t } = useI18n();
  const [coverage, setCoverage] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState("all");
  const [index, setIndex] = useState(0);
  const [offset, setOffset] = useState(0);

  useEffect(() => setOffset(0), [side]);

  useEffect(() => {
    let cancelled = false;
    setCoverage(null);
    setError(null);
    void runtimeApi.extractionCoverage(side, {
      refresh: refreshVersion > 0 || retry > 0,
      offset,
      limit: REVIEW_PAGE_SIZE,
    })
      .then((value) => { if (!cancelled) { setCoverage(value); setIndex(0); } })
      .catch((nextError) => { if (!cancelled) { setError(nextError); onError(nextError); } });
    return () => { cancelled = true; };
  }, [offset, onError, refreshVersion, retry, side]);

  const frames = useMemo(() => {
    if (!coverage) return [];
    if (filter === "missing") return coverage.items.filter((item) => item.faceCount === 0);
    if (filter === "multi") return coverage.items.filter((item) => item.faceCount > 1);
    return coverage.items;
  }, [coverage, filter]);
  const selected = frames[Math.min(index, Math.max(frames.length - 1, 0))] ?? null;

  if (error) return <ErrorState error={error} onRetry={() => setRetry((value) => value + 1)} />;
  if (!coverage) return <LoadingState label={t("正在关联源帧、source_rect 与 landmarks…")} />;
  if (!coverage.total) return <div className="tool-workbench-state"><IconPhoto size={26} /><strong>{t("还没有源帧")}</strong><span>{t("先从视频提取帧，再进行手动提取复核。")}</span></div>;

  return (
    <div className="extraction-review-layout">
      <section className="extraction-review-stage">
        <CompactSummary>
          <div><span>{t("源帧")}</span><strong>{coverage.total}</strong></div>
          <div><span>{t("已覆盖")}</span><strong>{coverage.coveredCount}</strong></div>
          <div className={coverage.uncoveredCount ? "is-warning" : ""}><span>{t("未提取")}</span><strong>{coverage.uncoveredCount}</strong></div>
          <div><span>{t("多人脸")}</span><strong>{coverage.multiFaceCount}</strong></div>
        </CompactSummary>
        <div className="tool-filter-row extraction-review-controls">
          <label>{t("帧范围")}
            <select aria-label={t("帧范围筛选") } value={filter} onChange={(event) => { setFilter(event.target.value); setIndex(0); }}>
              <option value="all">{t("全部帧")}</option>
              <option value="missing">{t("仅未提取")}</option>
              <option value="multi">{t("仅多人脸")}</option>
            </select>
          </label>
          <div className="frame-stepper">
            <button type="button" aria-label={t("上一帧")} disabled={index <= 0} onClick={() => setIndex((value) => Math.max(0, value - 1))}><IconChevronLeft size={17} /></button>
            <span>{frames.length ? `${index + 1} / ${frames.length}` : "0 / 0"}</span>
            <button type="button" aria-label={t("下一帧")} disabled={index >= frames.length - 1} onClick={() => setIndex((value) => Math.min(frames.length - 1, value + 1))}><IconChevronRight size={17} /></button>
          </div>
          <div className="frame-stepper">
            <button type="button" aria-label={t("上一批")} disabled={offset <= 0} onClick={() => setOffset((value) => Math.max(0, value - REVIEW_PAGE_SIZE))}><IconChevronLeft size={17} /></button>
            <span>{coverage.total ? `${coverage.offset + 1}–${coverage.offset + coverage.analyzedCount} / ${coverage.total}` : "0 / 0"}</span>
            <button type="button" aria-label={t("下一批")} disabled={coverage.offset + coverage.analyzedCount >= coverage.total} onClick={() => setOffset((value) => value + REVIEW_PAGE_SIZE)}><IconChevronRight size={17} /></button>
          </div>
        </div>
        {selected ? (
          <div className="extraction-canvas" style={{ aspectRatio: `${selected.width || 16} / ${selected.height || 9}` }}>
            <img src={selected.frameUrl} alt="" decoding="async" />
            {selected.width && selected.height && (
              <svg viewBox={`0 0 ${selected.width} ${selected.height}`} aria-label={t("已提取人脸覆盖层") }>
                {selected.faces.map((face) => face.rect && (
                  <g key={face.alignedName}>
                    <rect x={face.rect[0]} y={face.rect[1]} width={face.rect[2] - face.rect[0]} height={face.rect[3] - face.rect[1]} />
                    {face.landmarks.map(([x, y], pointIndex) => <circle key={`${face.alignedName}-${pointIndex}`} cx={x} cy={y} r="1.8" />)}
                  </g>
                ))}
              </svg>
            )}
            <span className={selected.faceCount ? "is-covered" : "is-missing"}>{selected.faceCount ? t("{count} 张 aligned", { count: selected.faceCount }) : t("未发现 aligned 输出")}</span>
          </div>
        ) : <div className="tool-inline-empty">{t("当前筛选下没有帧")}</div>}
      </section>
      <aside className="tool-inspector extraction-strip">
        <header><div><span>{t("提取复核")}</span><strong>{selected?.name ?? "—"}</strong></div><small>{t("只读覆盖")}</small></header>
        <p>{t("覆盖层来自 aligned 文件内的 source_rect 和 source_landmarks，不会重新运行或伪造检测器结果。")}</p>
        <div className="extraction-face-list">
          {selected?.faces.map((face) => (
            <div key={face.alignedName}><img src={face.alignedUrl} alt="" loading="lazy" decoding="async" /><span>{face.alignedName}</span></div>
          ))}
          {selected && !selected.faces.length && <div className="tool-inline-empty">{t("这帧尚无 aligned 人脸")}</div>}
        </div>
        <div className="tool-inspector-actions">
          <button type="button" onClick={() => onOpenCommand(`${side}.extract_faces`)}><IconPlayerPlay size={15} />{t("打开提取命令")}<IconArrowRight size={14} /></button>
          <small>{t("需要逐帧画框时，在任务向导中选择 manual 检测器；原快捷键窗口会接管精修。")}</small>
        </div>
      </aside>
    </div>
  );
}

export function MergeReviewPanel({ refreshVersion, onError, onOpenCommand }) {
  const { t } = useI18n();
  const [review, setReview] = useState(null);
  const [error, setError] = useState(null);
  const [index, setIndex] = useState(0);
  const [retry, setRetry] = useState(0);
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setReview(null);
    setError(null);
    void runtimeApi.mergeReview({ offset, limit: REVIEW_PAGE_SIZE })
      .then((value) => { if (!cancelled) { setReview(value); setIndex(0); } })
      .catch((nextError) => { if (!cancelled) { setError(nextError); onError(nextError); } });
    return () => { cancelled = true; };
  }, [offset, onError, refreshVersion, retry]);
  const selected = review?.items[index] ?? null;
  if (error) return <ErrorState error={error} onRetry={() => setRetry((value) => value + 1)} />;
  if (!review) return <LoadingState label={t("正在建立源帧、合成帧与遮罩索引…")} />;
  return (
    <div className="merge-review-panel">
      <CompactSummary>
        <div><span>{t("目标帧")}</span><strong>{review.total}</strong></div>
        <div><span>{t("三联完整")}</span><strong>{review.completeCount}</strong></div>
        <div className={review.missingMergedCount ? "is-warning" : ""}><span>{t("缺合成帧")}</span><strong>{review.missingMergedCount}</strong></div>
        <div className={review.missingMaskCount ? "is-warning" : ""}><span>{t("缺遮罩")}</span><strong>{review.missingMaskCount}</strong></div>
        <div className="frame-stepper"><button type="button" aria-label={t("上一帧")} disabled={index <= 0} onClick={() => setIndex((value) => value - 1)}><IconChevronLeft size={17} /></button><span>{review.items.length ? `${index + 1} / ${review.items.length}` : "0 / 0"}</span><button type="button" aria-label={t("下一帧")} disabled={index >= review.items.length - 1} onClick={() => setIndex((value) => value + 1)}><IconChevronRight size={17} /></button></div>
        <div className="frame-stepper"><button type="button" aria-label={t("上一批")} disabled={offset <= 0} onClick={() => setOffset((value) => Math.max(0, value - REVIEW_PAGE_SIZE))}><IconChevronLeft size={17} /></button><span>{review.total ? `${review.offset + 1}–${review.offset + review.items.length} / ${review.total}` : "0 / 0"}</span><button type="button" aria-label={t("下一批")} disabled={review.offset + review.items.length >= review.total} onClick={() => setOffset((value) => value + REVIEW_PAGE_SIZE)}><IconChevronRight size={17} /></button></div>
      </CompactSummary>
      {selected ? (
        <>
          <div className="merge-triptych">
            {[{ label: t("DST 原帧"), url: selected.sourceUrl }, { label: t("合成结果"), url: selected.mergedUrl }, { label: t("合成遮罩"), url: selected.maskUrl }].map((item) => (
              <figure key={item.label}><figcaption>{item.label}</figcaption>{item.url ? <img src={item.url} alt="" /> : <div><IconAlertTriangle size={22} />{t("文件缺失")}</div>}</figure>
            ))}
          </div>
          <div className="merge-review-footer"><span>{selected.name}</span><strong className={selected.complete ? "is-ok" : "is-warning"}>{selected.complete ? t("可进入编码复核") : t("需要重新合成")}</strong><button className="button primary" type="button" onClick={() => onOpenCommand("merge.saehd")}><IconPlayerPlay size={15} />{t("打开引导式合成")}</button></div>
        </>
      ) : <div className="tool-workbench-state"><IconPhoto size={26} /><strong>{t("还没有 DST 帧")}</strong><span>{t("先提取目标视频帧，再进行合成复核。")}</span></div>}
    </div>
  );
}

export function VideoTimelinePanel({ side, refreshVersion, onError, onOpenCommand }) {
  const { t } = useI18n();
  const [workspace, setWorkspace] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setWorkspace(null);
    void runtimeApi.workspace().then((value) => { if (!cancelled) setWorkspace(value); }).catch((nextError) => { if (!cancelled) { setError(nextError); onError(nextError); } });
    return () => { cancelled = true; };
  }, [onError, refreshVersion, retry]);
  if (error) return <ErrorState error={error} onRetry={() => setRetry((value) => value + 1)} />;
  if (!workspace) return <LoadingState label={t("正在读取视频流信息…")} />;
  const material = workspace.materials[side];
  if (!material) return <div className="tool-workbench-state"><IconPhoto size={26} /><strong>{t("{side} 视频尚未导入", { side: side.toUpperCase() })}</strong><span>{t("在工作区页面导入素材后，时间线和裁剪预检会出现在这里。")}</span></div>;
  return (
    <div className="video-tool-layout">
      <section className="video-stage">
        <video key={side} controls preload="metadata" poster={`/api/assets/${side}/poster`} src={`/api/workspace/materials/${side}`} />
        <div className="video-time-ruler" aria-hidden="true">{[0, 25, 50, 75, 100].map((value) => <span key={value} style={{ left: `${value}%` }}>{value}%</span>)}</div>
      </section>
      <aside className="tool-inspector">
        <header><div><span>{t("视频素材")}</span><strong>{material.name}</strong></div><small>{side.toUpperCase()}</small></header>
        <dl className="tool-inspector-data">
          <div><dt>{t("时长")}</dt><dd>{material.durationSeconds ? `${material.durationSeconds.toFixed(2)} s` : "—"}</dd></div>
          <div><dt>{t("分辨率")}</dt><dd>{material.width && material.height ? `${material.width} × ${material.height}` : "—"}</dd></div>
          <div><dt>{t("帧率")}</dt><dd>{material.frameRate ?? "—"}</dd></div>
          <div><dt>{t("文件大小")}</dt><dd>{formatBytes(material.bytes)}</dd></div>
          <div><dt>{t("修改时间")}</dt><dd>{new Date(material.modifiedAt).toLocaleString()}</dd></div>
        </dl>
        <p>{t("浏览器预览只读取原素材；裁剪、抽帧、降噪和回编码仍由固定 VideoEd / ffmpeg 命令执行。")}</p>
        <div className="tool-inspector-actions">
          <button type="button" onClick={() => onOpenCommand(`video.cut_${side}`)}><IconCode size={15} />{t("打开时间码裁剪")}</button>
          <button type="button" onClick={() => onOpenCommand(`${side}.extract_frames`)}><IconPlayerPlay size={15} />{t("打开抽帧命令")}</button>
          {side === "dst" && <button type="button" onClick={() => onOpenCommand("dst.denoise_frames")}><IconCode size={15} />{t("打开序列降噪")}</button>}
        </div>
      </aside>
    </div>
  );
}

export function MetadataPackPanel({ side, refreshVersion, onError, onOpenCommand }) {
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setData(null);
    Promise.all([
      runtimeApi.alignedAudit(side, { refresh: refreshVersion > 0 || retry > 0 }),
      runtimeApi.alignedPack(side, { refresh: refreshVersion > 0 || retry > 0 }),
    ]).then(([audit, pack]) => { if (!cancelled) setData({ audit, pack }); }).catch((nextError) => { if (!cancelled) { setError(nextError); onError(nextError); } });
    return () => { cancelled = true; };
  }, [onError, refreshVersion, retry, side]);
  if (error) return <ErrorState error={error} onRetry={() => setRetry((value) => value + 1)} />;
  if (!data) return <LoadingState label={t("正在审计 DFL 元数据与 PackedFaceset…")} />;
  const { audit, pack } = data;
  return (
    <div className="metadata-pack-layout">
      <section className="metadata-ledger">
        <header><div><h3>{t("元数据覆盖")}</h3><p>{t("读取每张 aligned 的 DFL 字典，不写入图片。")}</p></div><strong>{audit.validMetadataCount} / {audit.analyzedCount}</strong></header>
        <dl>
          <div><dt>{t("无效或缺失")}</dt><dd className={audit.invalidMetadataCount ? "is-warning" : ""}>{audit.invalidMetadataCount}</dd></div>
          <div><dt>{t("唯一源帧")}</dt><dd>{audit.uniqueSourceCount}</dd></div>
          <div><dt>{t("重复来源组")}</dt><dd>{audit.duplicateSourceGroupCount}</dd></div>
          <div><dt>{t("已应用遮罩")}</dt><dd>{audit.maskedCount}</dd></div>
        </dl>
        <div className="metadata-commands"><button className="button secondary" type="button" onClick={() => onOpenCommand(`${side}.metadata_save`)}>{t("保存元数据快照")}</button><button className="button secondary" type="button" onClick={() => onOpenCommand(`${side}.metadata_restore`)}>{t("打开恢复命令")}</button></div>
      </section>
      <section className="pack-ledger">
        <header><div><h3>{t("PackedFaceset")}</h3><p>{t("只解析固定包头、配置数量和完整性标记。")}</p></div><span className={pack.status === "ready" ? "is-ok" : pack.status === "invalid" ? "is-warning" : ""}>{pack.status === "ready" ? t("可用") : pack.status === "invalid" ? t("异常") : t("未打包")}</span></header>
        <dl>
          <div><dt>{t("格式")}</dt><dd>{pack.format?.toUpperCase() ?? "—"}</dd></div>
          <div><dt>{t("样本数")}</dt><dd>{pack.sampleCount ?? 0}</dd></div>
          <div><dt>{t("大小")}</dt><dd>{formatBytes(pack.bytes)}</dd></div>
          <div><dt>{t("校验摘要")}</dt><dd>{pack.sha256Prefix ?? "—"}</dd></div>
        </dl>
        {pack.warnings?.length > 0 && <div className="tool-issue-list">{pack.warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>}
        <div className="metadata-commands"><button className="button primary" type="button" onClick={() => onOpenCommand(`${side}.faces_pack`)}>{t("打开打包命令")}</button><button className="button secondary" type="button" onClick={() => onOpenCommand(`${side}.faces_unpack`)} disabled={!pack.present}>{t("打开解包命令")}</button></div>
      </section>
    </div>
  );
}

export function ExportPreflightPanel({ refreshVersion, onError, onOpenCommand }) {
  const { t } = useI18n();
  const [preflight, setPreflight] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setPreflight(null);
    void runtimeApi.exportPreflight().then((value) => { if (!cancelled) setPreflight(value); }).catch((nextError) => { if (!cancelled) { setError(nextError); onError(nextError); } });
    return () => { cancelled = true; };
  }, [onError, refreshVersion, retry]);
  if (error) return <ErrorState error={error} onRetry={() => setRetry((value) => value + 1)} />;
  if (!preflight) return <LoadingState label={t("正在检查模型家族、数据文件与权重…")} />;
  return (
    <div className="export-preflight-layout">
      <CompactSummary><div><span>{t("模型组")}</span><strong>{preflight.modelCount}</strong></div><div><span>{t("可导出")}</span><strong>{preflight.readyCount}</strong></div><div><span>{t("已有 DFM")}</span><strong>{preflight.outputCount}</strong></div><small>{t("固定规则预检")}</small></CompactSummary>
      {preflight.models.length ? <div className="export-model-rows">{preflight.models.map((model) => (
        <article key={`${model.type}:${model.name}`}>
          <div className="export-model-heading"><div><strong>{model.name}</strong><span>{model.type}</span></div><em className={model.ready ? "is-ok" : "is-warning"}>{model.ready ? t("就绪") : t("未就绪")}</em></div>
          <dl><div><dt>{t("组件")}</dt><dd>{model.fileCount}</dd></div><div><dt>{t("权重")}</dt><dd>{model.weightFileCount}</dd></div><div><dt>{t("大小")}</dt><dd>{formatBytes(model.bytes)}</dd></div><div><dt>{t("数据文件")}</dt><dd>{model.dataFileCount}</dd></div></dl>
          {model.blockers.length > 0 && <div className="tool-issue-list">{model.blockers.map((blocker) => <span key={blocker}>{blocker === "model_data_missing" ? t("缺少模型 data.dat") : blocker === "model_weights_missing" ? t("缺少权重组件") : t("当前类型不支持 DFM")}</span>)}</div>}
          <button className="button primary" type="button" disabled={!model.ready} onClick={() => onOpenCommand(model.commandId)}><IconPlayerPlay size={15} />{t("打开 DFM 导出")}</button>
        </article>
      ))}</div> : <div className="tool-workbench-state"><IconCode size={26} /><strong>{t("workspace/model 中没有可识别模型")}</strong><span>{t("训练生成 SAEHD、ME、Q384 或 Q512 模型后，组件预检会在这里显示。")}</span><button className="button primary" type="button" onClick={() => onOpenCommand("train.saehd")}>{t("打开训练任务")}</button></div>}
      {preflight.outputs.length > 0 && <section className="dfm-output-list"><h3>{t("已有导出")}</h3>{preflight.outputs.map((output) => <div key={output.name}><span>{output.name}</span><strong>{formatBytes(output.bytes)}</strong><small>{new Date(output.modifiedAt).toLocaleString()}</small></div>)}</section>}
    </div>
  );
}
