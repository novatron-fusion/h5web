import { formatTick } from '@h5web/shared/vis-utils';
import uPlot from 'uplot';

import styles from '../OverlayVisualizer.module.css';
import { type LegendGroup, type NxCurveData } from './models';

export const COLORS = [
  'darkblue',
  'orangered',
  'forestgreen',
  'red',
  'mediumorchid',
  'olive',
  'teal',
  'sienna',
];

/**
 * Extract unit string from a long_name label like "Forward_Power [dBm]".
 * Returns the text inside the last `[…]` pair, or undefined if empty/absent.
 */
export function extractUnitFromLabel(label: string): string | undefined {
  const trimmed = label.trimEnd();
  if (!trimmed.endsWith(']')) {
    return undefined;
  }
  const openIdx = trimmed.lastIndexOf('[');
  if (openIdx === -1) {
    return undefined;
  }
  const unit = trimmed.slice(openIdx + 1, -1).trim();
  return unit || undefined; // empty brackets → undefined
}

/**
 * Strip the trailing unit bracket from a label.
 * "Forward_Power [dBm]" → "Forward_Power"
 */
export function stripUnitSuffix(label: string): string {
  const trimmed = label.trimEnd();
  if (!trimmed.endsWith(']')) {
    return trimmed;
  }
  const openIdx = trimmed.lastIndexOf('[');
  if (openIdx === -1) {
    return trimmed;
  }
  return trimmed.slice(0, openIdx).trim();
}

/**
 * Group curves by their signal unit. Returns an ordered list of unique unit
 * strings and a map from unit to the curves that belong to it.
 */
export function groupByUnit(curves: NxCurveData[]): {
  unitOrder: string[];
  unitMap: Map<string, NxCurveData[]>;
} {
  const unitMap = new Map<string, NxCurveData[]>();

  for (const curve of curves) {
    const key = curve.unit ?? '';
    const group = unitMap.get(key) ?? [];
    group.push(curve);
    unitMap.set(key, group);
  }

  return { unitOrder: [...unitMap.keys()], unitMap };
}

/**
 * Build uPlot-compatible aligned data from multiple curves.
 *
 * Uses `uPlot.join()` to outer-join all curves onto a common x-axis.
 * Each curve is passed as its own small table [xs, ys] so that curves
 * with different x-ranges/sampling are correctly aligned.
 */
export function buildAlignedData(curves: NxCurveData[]): uPlot.AlignedData {
  if (curves.length === 0) {
    return [[]];
  }

  const tables: uPlot.AlignedData[] = curves.map((curve) => [
    Array.from(curve.abscissas, Number),
    Array.from(curve.ordinates, Number),
  ]);

  return uPlot.join(tables);
}

export function getCurveColor(index: number): string {
  return COLORS[index % COLORS.length];
}

/**
 * Build legend item descriptors grouped by unit.
 * Must be pure (no closure over mutable index) to satisfy lint.
 */
export function buildLegendGroups(
  unitOrder: string[],
  unitMap: Map<string, NxCurveData[]>,
): LegendGroup[] {
  const groups: LegendGroup[] = [];

  let globalIdx = 0;
  for (const unit of unitOrder) {
    const curves = unitMap.get(unit) ?? [];
    const items: LegendGroup['items'] = [];

    for (const curve of curves) {
      items.push({
        seriesIdx: globalIdx + 1, // +1 because series[0] is x-axis in uPlot
        path: curve.path,
        subsystem: curve.subsystem,
        label: curve.label,
        color: getCurveColor(globalIdx),
      });
      globalIdx++;
    }

    groups.push({ unit, items });
  }

  return groups;
}

/**
 * Build tooltip HTML content for the current cursor position.
 */
export function buildTooltipHtml(
  u: uPlot,
  idx: number,
  seriesUnits: (string | undefined)[],
): string {
  const xVal = u.data[0][idx];

  const axisLabel = u.axes[0]?.label;
  const axisPrefix =
    typeof axisLabel === 'string' && axisLabel ? `${axisLabel}: ` : '';
  let html = `<div class="${styles.tooltipHeader}">${axisPrefix}${formatTick(xVal)}</div>`;

  for (let i = 1; i < u.series.length; i++) {
    const s = u.series[i];
    if (!s.show) {
      continue;
    }
    const val = u.data[i]?.[idx];
    if (val === null || val === undefined) {
      continue;
    }
    const color = typeof s.stroke === 'string' ? s.stroke : '';
    const label = typeof s.label === 'string' ? s.label : '';
    const unit = seriesUnits[i];
    const unitSuffix = unit ? ` ${unit}` : '';
    html += `<div class="${styles.tooltipRow}"><span class="${styles.tooltipSwatch}" style="background:${color}"></span>${label}: ${formatTick(val)}${unitSuffix}</div>`;
  }

  return html;
}

/**
 * Position the tooltip near the cursor, flipping when close to edges.
 */
export function positionTooltip(
  tip: HTMLDivElement,
  u: uPlot,
  cursorX: number,
  cursorY: number,
): void {
  const overEl = u.over;
  const plotLeft = overEl.offsetLeft;
  const plotTop = overEl.offsetTop;
  let left = plotLeft + cursorX + 15;
  let top = plotTop + cursorY + 15;

  // Flip horizontally if it would overflow the right edge
  const wrapperWidth = tip.parentElement?.clientWidth ?? 0;
  if (left + tip.offsetWidth > wrapperWidth - 10) {
    left = plotLeft + cursorX - tip.offsetWidth - 15;
  }

  // Flip vertically if it would overflow the bottom edge
  const wrapperHeight = tip.parentElement?.clientHeight ?? 0;
  if (top + tip.offsetHeight > wrapperHeight - 10) {
    top = plotTop + cursorY - tip.offsetHeight - 15;
  }

  Object.assign(tip.style, { left: `${left}px`, top: `${top}px` });
}
