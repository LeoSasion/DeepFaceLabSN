const BALANCE_FLOOR = 0.005;
const BALANCE_TOLERANCE = 0.25;

function ratio(count, total) {
  return total > 0 ? count / total : 0;
}

function classifyCell(srcCount, dstCount, srcShare, dstShare) {
  if (!srcCount && !dstCount) return "empty";
  if (!srcCount && dstCount) return "missing-src";
  if (srcCount && !dstCount) return "src-only";

  const difference = dstShare - srcShare;
  const tolerance = Math.max(
    BALANCE_FLOOR,
    Math.max(srcShare, dstShare) * BALANCE_TOLERANCE,
  );
  if (Math.abs(difference) <= tolerance) return "balanced";
  return difference > 0 ? "src-deficit" : "src-surplus";
}

export function buildPoseComparison(srcAtlas, dstAtlas) {
  const srcTotal = srcAtlas?.validCount ?? 0;
  const dstTotal = dstAtlas?.validCount ?? 0;
  const srcCells = new Map((srcAtlas?.cells ?? []).map((cell) => [cell.id, cell]));
  const dstCells = new Map((dstAtlas?.cells ?? []).map((cell) => [cell.id, cell]));
  const ids = new Set([...srcCells.keys(), ...dstCells.keys()]);

  let distributionDistance = 0;
  let dstOccupied = 0;
  let dstCovered = 0;
  let gapCount = 0;
  let deficitCount = 0;

  const cells = [...ids].map((id) => {
    const src = srcCells.get(id) ?? null;
    const dst = dstCells.get(id) ?? null;
    const srcCount = src?.count ?? 0;
    const dstCount = dst?.count ?? 0;
    const srcShare = ratio(srcCount, srcTotal);
    const dstShare = ratio(dstCount, dstTotal);
    const difference = dstShare - srcShare;
    const status = classifyCell(srcCount, dstCount, srcShare, dstShare);

    distributionDistance += Math.abs(difference);
    if (dstCount) {
      dstOccupied += 1;
      if (srcCount) dstCovered += 1;
    }
    if (status === "missing-src") gapCount += 1;
    if (status === "missing-src" || status === "src-deficit") deficitCount += 1;

    return {
      id,
      pitch: src?.pitch ?? dst?.pitch ?? 0,
      yaw: src?.yaw ?? dst?.yaw ?? 0,
      src,
      dst,
      srcCount,
      dstCount,
      srcShare,
      dstShare,
      difference,
      status,
      level: Math.min(1, Math.abs(difference) * 8),
    };
  });

  const hasBothDatasets = srcTotal > 0 && dstTotal > 0;
  return {
    srcTotal,
    dstTotal,
    hasBothDatasets,
    matchScore: hasBothDatasets ? Math.max(0, 1 - (distributionDistance / 2)) : 0,
    destinationCoverage: dstOccupied ? dstCovered / dstOccupied : 0,
    gapCount,
    deficitCount,
    cells,
  };
}
