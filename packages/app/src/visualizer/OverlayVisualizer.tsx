import 'uplot/dist/uPlot.min.css';

import { assertGroup } from '@h5web/shared/guards';
import { type NumArray } from '@h5web/shared/vis-models';
import { formatTick } from '@h5web/shared/vis-utils';
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { FiRefreshCw } from 'react-icons/fi';
import uPlot from 'uplot';

import { useEntity, useValue } from '../hooks';
import { useDataContext } from '../providers/DataProvider';
import { findScalarStrAttr, getAttributeValue } from '../utils';
import { toNumArray } from '../vis-packs/core/utils';
import { assertNumericLikeNxData } from '../vis-packs/nexus/guards';
import { useNxData, usePrefetchNxValues } from '../vis-packs/nexus/hooks';
import styles from './OverlayVisualizer.module.css';
import visualizerStyles from './Visualizer.module.css';

const COLORS = [
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
function extractUnitFromLabel(label: string): string | undefined {
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
function stripUnitSuffix(label: string): string {
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

interface NxCurveData {
  path: string;
  subsystem: string;
  label: string;
  unit: string | undefined;
  xLabel: string | undefined;
  abscissas: NumArray;
  ordinates: NumArray;
}

interface Props {
  checkedPaths: string[];
  hidden?: boolean;
  onRemovePath: (path: string) => void;
}

function OverlayVisualizer(props: Props) {
  const { checkedPaths, hidden, onRemovePath } = props;

  if (checkedPaths.length === 0) {
    return (
      <div className={styles.wrapper} hidden={hidden}>
        <div className={visualizerStyles.fallback}>
          <p>No datasets selected for overlay</p>
          <p className={visualizerStyles.fallbackHint}>
            Check NXdata groups in the sidebar to overlay their signals.
          </p>
        </div>
      </div>
    );
  }

  // Key on sorted paths so the component remounts when the set of paths changes.
  // This keeps the hook call count stable inside OverlayChart.
  const key = [...checkedPaths].sort().join('\n');

  return (
    <div className={styles.wrapper} hidden={hidden}>
      <Suspense
        key={key}
        fallback={
          <div className={styles.loading}>
            <FiRefreshCw className={styles.spinner} />
            <p>Loading overlay data...</p>
          </div>
        }
      >
        <OverlayChart checkedPaths={checkedPaths} onRemovePath={onRemovePath} />
      </Suspense>
    </div>
  );
}

function useNxCurveData(path: string): NxCurveData {
  const entity = useEntity(path);
  assertGroup(entity);
  const { attrValuesStore } = useDataContext();

  const nxData = useNxData(entity);
  assertNumericLikeNxData(nxData);

  const { signalDef, axisDefs } = nxData;

  const axisDatasets = axisDefs.map((def) => def?.dataset);
  usePrefetchNxValues([...axisDatasets]);
  usePrefetchNxValues([signalDef.dataset]);

  const signal = useValue(signalDef.dataset);

  // Fetch x-axis: last axis = innermost dimension
  const xAxisDef = axisDefs[axisDefs.length - 1];
  const xAxisValue = useValue(xAxisDef?.dataset);

  const ordinates = toNumArray(signal);
  const abscissas: NumArray = xAxisValue
    ? toNumArray(xAxisValue)
    : Array.from({ length: ordinates.length }, (_, i) => i);

  // Read unit: prefer NeXus `units` on signal dataset, then `Unit` on group, then parse from long_name
  const groupUnitAttr = findScalarStrAttr(entity, 'Unit');
  const groupUnit = getAttributeValue(entity, groupUnitAttr, attrValuesStore);
  const rawLabel = signalDef.label || path.split('/').pop() || path;
  const unit = signalDef.unit ?? groupUnit ?? extractUnitFromLabel(rawLabel);
  const label = unit ? stripUnitSuffix(rawLabel) : rawLabel;

  // Extract subsystem name from the parent path segment
  const segments = path.split('/');
  const subsystem = segments.length >= 2 ? segments[segments.length - 2] : '';

  return {
    path,
    subsystem,
    label,
    unit,
    xLabel: xAxisDef?.label,
    abscissas,
    ordinates,
  };
}

/**
 * Group curves by their signal unit. Returns an ordered list of unique unit
 * strings and a map from unit to the curves that belong to it.
 */
function groupByUnit(curves: NxCurveData[]): {
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
function buildAlignedData(curves: NxCurveData[]): uPlot.AlignedData {
  if (curves.length === 0) {
    return [[]];
  }

  const tables: uPlot.AlignedData[] = curves.map((curve) => [
    Array.from(curve.abscissas, Number),
    Array.from(curve.ordinates, Number),
  ]);

  return uPlot.join(tables);
}

function getCurveColor(index: number): string {
  return COLORS[index % COLORS.length];
}

/**
 * Build tooltip HTML content for the current cursor position.
 * Returns the HTML string, or undefined if there is nothing to show.
 */
function buildTooltipHtml(
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
function positionTooltip(
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

/**
 * Build legend item descriptors grouped by unit.
 * Must be pure (no closure over mutable index) to satisfy lint.
 */
function buildLegendGroups(
  unitOrder: string[],
  unitMap: Map<string, NxCurveData[]>,
) {
  const groups: {
    unit: string;
    items: {
      seriesIdx: number;
      path: string;
      subsystem: string;
      label: string;
      color: string;
    }[];
  }[] = [];

  let globalIdx = 0;
  for (const unit of unitOrder) {
    const curves = unitMap.get(unit) ?? [];
    const items: {
      seriesIdx: number;
      path: string;
      subsystem: string;
      label: string;
      color: string;
    }[] = [];

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

// eslint-disable-next-line react/no-multi-comp -- OverlayChart is tightly coupled to OverlayVisualizer
function OverlayChart(props: {
  checkedPaths: string[];
  onRemovePath: (path: string) => void;
}) {
  const { checkedPaths, onRemovePath } = props;

  // Fetch all NX curve data.
  // The hook call count is stable because the parent component is keyed
  // on the sorted checkedPaths, forcing a full remount when the set changes.
  const curves: NxCurveData[] = [];
  for (const path of checkedPaths) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    curves.push(useNxCurveData(path));
  }

  // Wrap in useMemo so downstream hooks get a stable reference.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the curve values, not the array identity
  const stableCurves = useMemo(() => curves, curves);

  const chartRef = useRef<HTMLDivElement>(null);
  const uPlotRef = useRef<uPlot | null>(null);
  const resetZoomRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Per-series unit strings (index 0 unused, matches uPlot series indexing)
  const seriesUnitsRef = useRef<(string | undefined)[]>([]);
  seriesUnitsRef.current = [undefined, ...stableCurves.map((c) => c.unit)];

  // Group curves by unit for multi-axis support
  const { unitOrder, unitMap } = useMemo(
    () => groupByUnit(stableCurves),
    [stableCurves],
  );

  // Build aligned data for uPlot
  const alignedData = useMemo(
    () => buildAlignedData(stableCurves),
    [stableCurves],
  );

  // Determine x-axis label from the first curve that has one
  const xLabel = useMemo(
    () => stableCurves.find((c) => c.xLabel)?.xLabel,
    [stableCurves],
  );

  // Build the flat color list matching series order
  const curveColors = useMemo(
    () => stableCurves.map((_, i) => getCurveColor(i)),
    [stableCurves],
  );

  // Scale key for each unit: first unit -> 'y' (left), others -> 'y2' (right)
  const scaleKeyForUnit = useCallback(
    (unit: string) => {
      const idx = unitOrder.indexOf(unit);
      return idx <= 0 ? 'y' : 'y2';
    },
    [unitOrder],
  );

  // Build uPlot options
  const opts = useMemo((): uPlot.Options => {
    const series: uPlot.Series[] = [{}]; // first entry is x-axis

    for (const [i, curve] of stableCurves.entries()) {
      const unit = curve.unit ?? '';
      series.push({
        label: curve.label,
        stroke: curveColors[i],
        width: 2,
        scale: scaleKeyForUnit(unit),
      });
    }

    const scales: uPlot.Scales = {
      x: { time: false },
      y: { auto: true },
    };

    if (unitOrder.length > 1) {
      scales.y2 = { auto: true };
    }

    const axes: uPlot.Axis[] = [
      {
        scale: 'x',
        label: xLabel,
        size: xLabel ? 50 : 40,
        gap: 5,
      },
      {
        scale: 'y',
        side: 3,
        label: unitOrder[0] || undefined,
        size: unitOrder[0] ? 70 : 50,
        gap: 5,
        grid: { show: true },
        values: (_u: uPlot, splits: number[]) =>
          splits.map((v) => formatTick(v)),
      },
    ];

    if (unitOrder.length > 1) {
      const secondaryLabels = unitOrder.slice(1);
      const rightLabel = secondaryLabels.join(', ');

      axes.push({
        scale: 'y2',
        side: 1,
        label: rightLabel || undefined,
        size: rightLabel ? 70 : 50,
        gap: 5,
        grid: { show: false },
        values: (_u: uPlot, splits: number[]) =>
          splits.map((v) => formatTick(v)),
      });
    }

    return {
      width: 800,
      height: 400,
      series,
      scales,
      axes,
      legend: { show: false },
      focus: { alpha: 0.3 },
      cursor: {
        drag: { x: true, y: false, setScale: true },
      },
      hooks: {
        setScale: [],
        setCursor: [],
      },
    };
  }, [stableCurves, curveColors, scaleKeyForUnit, unitOrder, xLabel]);

  // Create / recreate uPlot instance when options or data change
  useEffect(() => {
    const container = chartRef.current;
    if (!container) {
      return undefined;
    }

    const rect = container.getBoundingClientRect();
    const o = { ...opts, width: rect.width, height: rect.height };

    // eslint-disable-next-line new-cap -- uPlot is a constructor with a lowercase name
    const plot = new uPlot(o, alignedData, container);
    uPlotRef.current = plot;

    // Track zoom state imperatively (no React state) to avoid
    // re-render → opts change → uPlot recreation → zoom lost.
    plot.hooks.setScale?.push(() => {
      const btn = resetZoomRef.current;
      if (!btn) {
        return;
      }
      const [xData] = plot.data;
      if (xData.length === 0) {
        return;
      }
      const [fullMin] = xData;
      const fullMax = xData[xData.length - 1];
      const curMin = plot.scales.x.min;
      const curMax = plot.scales.x.max;
      if (curMin === undefined || curMax === undefined) {
        return;
      }
      const zoomed =
        curMin > fullMin + 1e-12 || curMax < fullMax - 1e-12;
      btn.hidden = !zoomed;
    });

    // Show tooltip with cursor values
    plot.hooks.setCursor?.push((u: uPlot) => {
      const tip = tooltipRef.current;
      if (!tip) {
        return;
      }

      const { idx, left: cursorX, top: cursorY } = u.cursor;
      if (idx === null || idx === undefined || !cursorX || cursorX < 0) {
        tip.hidden = true;
        return;
      }

      tip.innerHTML = buildTooltipHtml(u, idx, seriesUnitsRef.current);
      tip.hidden = false;
      positionTooltip(tip, u, cursorX, cursorY ?? 0);
    });

    return () => {
      plot.destroy();
      uPlotRef.current = null;
    };
  }, [opts, alignedData]);

  // Resize chart when container size changes
  useEffect(() => {
    const container = chartRef.current;
    if (!container) {
      return undefined;
    }

    const ro = new ResizeObserver(([entry]) => {
      if (!uPlotRef.current) {
        return;
      }

      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        uPlotRef.current.setSize({ width, height });
      }
    });

    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Reset zoom by re-setting data with resetScales flag
  const resetZoom = useCallback(() => {
    const plot = uPlotRef.current;
    if (!plot) {
      return;
    }
    plot.setData(plot.data, true);
    // Button will be hidden by the setScale hook firing after reset
  }, []);

  // Toggle series visibility via the uPlot API + imperative legend update
  // (no React state/forceRender to avoid uPlot recreation)
  const toggleSeries = useCallback(
    (seriesIdx: number, btn: HTMLButtonElement) => {
      const plot = uPlotRef.current;
      if (!plot) {
        return;
      }
      const current = plot.series[seriesIdx]?.show ?? true;
      plot.setSeries(seriesIdx, { show: !current });

      const nowVisible = !current;
      btn.setAttribute('aria-pressed', String(nowVisible));
      const colorEl = btn.querySelector<HTMLElement>(`.${styles.legendColor}`);
      const labelEl = btn.querySelector<HTMLElement>(`.${styles.legendLabel}`);
      if (colorEl) {
        colorEl.style.opacity = nowVisible ? '1' : '0.3';
      }
      if (labelEl) {
        labelEl.style.opacity = nowVisible ? '1' : '0.5';
      }
    },
    [],
  );

  // Highlight a series on legend hover (imperative to avoid re-render)
  const focusSeries = useCallback(
    (seriesIdx: number | null) => {
      const plot = uPlotRef.current;
      if (!plot) {
        return;
      }
      if (seriesIdx !== null) {
        plot.setSeries(seriesIdx, { focus: true });
      } else {
        plot.setSeries(null, { focus: false });
      }
    },
    [],
  );

  // Build legend items grouped by unit
  const legendGroups = useMemo(
    () => buildLegendGroups(unitOrder, unitMap),
    [unitOrder, unitMap],
  );

  return (
    <div className={styles.container}>
      <div className={styles.legend}>
        {legendGroups.map((group) => (
          <div key={group.unit} className={styles.legendGroup}>
            {unitOrder.length > 1 && group.unit && (
              <span className={styles.legendUnit}>{group.unit}</span>
            )}
            {group.items.map((item) => (
                <span key={item.seriesIdx} className={styles.legendEntry}>
                  <button
                    type="button"
                    className={styles.legendItem}
                    aria-pressed
                    onClick={(e) =>
                      toggleSeries(
                        item.seriesIdx,
                        e.currentTarget,
                      )
                    }
                    onMouseEnter={() => focusSeries(item.seriesIdx)}
                    onMouseLeave={() => focusSeries(null)}
                  >
                    <span
                      className={styles.legendColor}
                      style={{ backgroundColor: item.color }}
                    />
                    <span className={styles.legendLabel}>
                      <span className={styles.legendSubsystem}>
                        {item.subsystem}
                      </span>
                      {item.label}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={styles.legendRemove}
                    aria-label={`Remove ${item.label}`}
                    onClick={() => onRemovePath(item.path)}
                  >
                    &times;
                  </button>
                </span>
            ))}
          </div>
        ))}
      </div>
      <div className={styles.chartWrapper}>
        <div ref={chartRef} className={styles.chartArea} />
        <button
          ref={resetZoomRef}
          type="button"
          hidden
          className={styles.resetZoom}
          onClick={resetZoom}
        >
          Reset zoom
        </button>
        <div ref={tooltipRef} className={styles.tooltip} hidden />
      </div>
    </div>
  );
}

export default OverlayVisualizer;
