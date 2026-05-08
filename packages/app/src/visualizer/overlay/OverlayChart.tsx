import 'uplot/dist/uPlot.min.css';

import { formatTick } from '@h5web/shared/vis-utils';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import uPlot from 'uplot';

import styles from '../OverlayVisualizer.module.css';
import { type NxCurveData } from './models';
import { useNxCurveData } from './useNxCurveData';
import {
  buildAlignedData,
  buildLegendGroups,
  buildTooltipHtml,
  getCurveColor,
  groupByUnit,
  positionTooltip,
} from './utils';

interface Props {
  checkedPaths: string[];
  onRemovePath: (path: string) => void;
}

function OverlayChart(props: Props) {
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

  const curveColorsRef = useRef<string[]>([]);
  curveColorsRef.current = curveColors;

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
        width: 1,
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
        drag: { x: true, y: true, setScale: true },
        bind: {
          mousedown: (
            _self: uPlot,
            _targ: HTMLElement,
            handler: (e: MouseEvent) => null,
          ) => {
            return (e: MouseEvent): null => {
              if (e.ctrlKey || e.metaKey) {
                handler(e);
              }
              return null;
            };
          },
        },
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
      const zoomed = curMin > fullMin + 1e-12 || curMax < fullMax - 1e-12;
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

      tip.innerHTML = buildTooltipHtml(
        u,
        idx,
        seriesUnitsRef.current,
        curveColorsRef.current,
      );
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
  const focusSeries = useCallback((seriesIdx: number | null) => {
    const plot = uPlotRef.current;
    if (!plot) {
      return;
    }
    if (seriesIdx !== null) {
      plot.setSeries(seriesIdx, { focus: true });
    } else {
      plot.setSeries(null, { focus: false });
    }
  }, []);

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
                  onClick={(e) => toggleSeries(item.seriesIdx, e.currentTarget)}
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

export default OverlayChart;
