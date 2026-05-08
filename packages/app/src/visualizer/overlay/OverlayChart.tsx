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

  const yAutoScaleRef = useRef(true);
  const fullExtentsRef = useRef<{
    xMin: number;
    xMax: number;
    yMin: number;
    yMax: number;
  } | null>(null);

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
      y: {
        auto: (_self: uPlot, resetScales: boolean) =>
          resetScales || yAutoScaleRef.current,
      },
    };

    if (unitOrder.length > 1) {
      scales.y2 = {
        auto: (_self: uPlot, resetScales: boolean) =>
          resetScales || yAutoScaleRef.current,
      };
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

    // Compute full extents with 5% padding for zoom/pan bounds
    let fullYMin = Infinity;
    let fullYMax = -Infinity;
    for (let si = 1; si < plot.data.length; si++) {
      const ys = plot.data[si];
      for (let j = 0; j < ys.length; j++) {
        const v = ys[j];
        if (v != null) {
          if (v < fullYMin) {
            fullYMin = v;
          }
          if (v > fullYMax) {
            fullYMax = v;
          }
        }
      }
    }
    const fullYRange = fullYMax - fullYMin;
    const yPad = fullYRange * 0.05;
    fullYMin -= yPad;
    fullYMax += yPad;

    const [xDataFull] = plot.data;
    const dataXMin = xDataFull[0];
    const dataXMax = xDataFull[xDataFull.length - 1];
    const rawXRange = dataXMax - dataXMin;
    const xPad = rawXRange * 0.05;
    const fullXMin = dataXMin - xPad;
    const fullXMax = dataXMax + xPad;

    fullExtentsRef.current = {
      xMin: fullXMin,
      xMax: fullXMax,
      yMin: fullYMin,
      yMax: fullYMax,
    };

    // Set initial scales to padded extents
    plot.batch(() => {
      plot.setScale('x', { min: fullXMin, max: fullXMax });
      plot.setScale('y', { min: fullYMin, max: fullYMax });
      if (plot.scales.y2) {
        plot.setScale('y2', { min: fullYMin, max: fullYMax });
      }
    });

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
      const curMin = plot.scales.x.min;
      const curMax = plot.scales.x.max;
      if (curMin === undefined || curMax === undefined) {
        return;
      }
      const zoomed = curMin > fullXMin + 1e-12 || curMax < fullXMax - 1e-12;
      btn.hidden = !zoomed;
      if (zoomed) {
        yAutoScaleRef.current = false;
      }
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

    // Click-drag panning (without Ctrl) and wheel zoom
    const over = plot.over;

    function isZoomed(): boolean {
      const [xData] = plot.data;
      if (xData.length === 0) {
        return false;
      }
      const curXMin = plot.scales.x.min;
      const curXMax = plot.scales.x.max;
      if (curXMin == null || curXMax == null) {
        return false;
      }
      if (curXMin > fullXMin + 1e-12 || curXMax < fullXMax - 1e-12) {
        return true;
      }
      const curYMin = plot.scales.y.min;
      const curYMax = plot.scales.y.max;
      if (curYMin != null && curYMax != null) {
        if (curYMin > fullYMin + 1e-12 || curYMax < fullYMax - 1e-12) {
          return true;
        }
      }
      return false;
    }
    let panStart: {
      clientX: number;
      clientY: number;
      xMin: number;
      xMax: number;
      yMin: number;
      yMax: number;
      y2Min: number;
      y2Max: number;
      xUnitsPerPx: number;
      yUnitsPerPx: number;
      y2UnitsPerPx: number;
    } | null = null;
    let rafPending = false;
    let lastClientX = 0;
    let lastClientY = 0;

    function onMouseDown(e: MouseEvent) {
      if (e.ctrlKey || e.metaKey || e.button !== 0) {
        return;
      }
      if (!isZoomed()) {
        return;
      }
      const xs = plot.scales.x;
      const ys = plot.scales.y;
      const y2s = plot.scales.y2;
      if (
        xs.min == null ||
        xs.max == null ||
        ys.min == null ||
        ys.max == null
      ) {
        return;
      }
      panStart = {
        clientX: e.clientX,
        clientY: e.clientY,
        xMin: xs.min,
        xMax: xs.max,
        yMin: ys.min,
        yMax: ys.max,
        y2Min: y2s?.min ?? 0,
        y2Max: y2s?.max ?? 0,
        xUnitsPerPx: plot.posToVal(1, 'x') - plot.posToVal(0, 'x'),
        yUnitsPerPx: plot.posToVal(1, 'y') - plot.posToVal(0, 'y'),
        y2UnitsPerPx: y2s ? plot.posToVal(1, 'y2') - plot.posToVal(0, 'y2') : 0,
      };
      over.style.cursor = 'grabbing';
    }

    function onMouseMove(e: MouseEvent) {
      if (!panStart) {
        return;
      }
      e.preventDefault();
      lastClientX = e.clientX;
      lastClientY = e.clientY;
      if (!rafPending) {
        rafPending = true;
        requestAnimationFrame(doPan);
      }
    }

    function doPan() {
      rafPending = false;
      if (!panStart) {
        return;
      }

      let dx = (lastClientX - panStart.clientX) * panStart.xUnitsPerPx;
      if (panStart.xMin - dx < fullXMin) {
        dx = panStart.xMin - fullXMin;
      }
      if (panStart.xMax - dx > fullXMax) {
        dx = panStart.xMax - fullXMax;
      }

      let dy = (lastClientY - panStart.clientY) * panStart.yUnitsPerPx;
      const yRange = panStart.yMax - panStart.yMin;
      if (panStart.yMin - dy < fullYMin) {
        dy = panStart.yMin - fullYMin;
      }
      if (panStart.yMax - dy > fullYMax) {
        dy = panStart.yMax - fullYMax;
      }

      plot.batch(() => {
        plot.setScale('x', {
          min: panStart!.xMin - dx,
          max: panStart!.xMax - dx,
        });
        plot.setScale('y', {
          min: panStart!.yMin - dy,
          max: panStart!.yMax - dy,
        });
        if (plot.scales.y2) {
          let dy2 = (lastClientY - panStart!.clientY) * panStart!.y2UnitsPerPx;
          const y2Range = panStart!.y2Max - panStart!.y2Min;
          if (panStart!.y2Min - dy2 < fullYMin) {
            dy2 = panStart!.y2Min - fullYMin;
          }
          if (panStart!.y2Max - dy2 > fullYMax) {
            dy2 = panStart!.y2Max - fullYMax;
          }
          plot.setScale('y2', {
            min: panStart!.y2Min - dy2,
            max: panStart!.y2Max - dy2,
          });
        }
      });
    }

    function onMouseUp() {
      if (panStart) {
        panStart = null;
        over.style.cursor = '';
      }
    }

    const WHEEL_ZOOM_FACTOR = 0.75;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const zoomingOut = e.deltaY > 0;
      if (zoomingOut && !isZoomed()) {
        return;
      }
      yAutoScaleRef.current = false;
      const { left, top } = plot.cursor;
      if (left == null || top == null) {
        return;
      }

      const zoomX = !e.shiftKey;
      const zoomY = !e.altKey;

      const leftPct = left / over.clientWidth;
      const btmPct = 1 - top / over.clientHeight;

      let nxMin = plot.scales.x.min!;
      let nxMax = plot.scales.x.max!;
      if (zoomX) {
        const oxRange = nxMax - nxMin;
        const nxRange = zoomingOut
          ? oxRange / WHEEL_ZOOM_FACTOR
          : oxRange * WHEEL_ZOOM_FACTOR;
        if (nxRange >= fullXMax - fullXMin) {
          yAutoScaleRef.current = false;
          plot.batch(() => {
            plot.setScale('x', { min: fullXMin, max: fullXMax });
            plot.setScale('y', { min: fullYMin, max: fullYMax });
            if (plot.scales.y2) {
              plot.setScale('y2', { min: fullYMin, max: fullYMax });
            }
          });
          return;
        }
        const xVal = plot.posToVal(left, 'x');
        nxMin = xVal - leftPct * nxRange;
        nxMax = nxMin + nxRange;
        if (nxMin < fullXMin) {
          nxMin = fullXMin;
          nxMax = fullXMin + nxRange;
        }
        if (nxMax > fullXMax) {
          nxMax = fullXMax;
          nxMin = fullXMax - nxRange;
        }
      }

      plot.batch(() => {
        plot.setScale('x', { min: nxMin, max: nxMax });
        if (zoomY) {
          const oyRange = plot.scales.y.max! - plot.scales.y.min!;
          let nyRange = zoomingOut
            ? oyRange / WHEEL_ZOOM_FACTOR
            : oyRange * WHEEL_ZOOM_FACTOR;
          if (zoomingOut && nyRange >= fullYMax - fullYMin) {
            plot.setScale('y', { min: fullYMin, max: fullYMax });
          } else {
            const yVal = plot.posToVal(top, 'y');
            const nyMin = yVal - btmPct * nyRange;
            plot.setScale('y', { min: nyMin, max: nyMin + nyRange });
          }
          if (plot.scales.y2) {
            const oy2Range = plot.scales.y2.max! - plot.scales.y2.min!;
            const ny2Range = zoomingOut
              ? oy2Range / WHEEL_ZOOM_FACTOR
              : oy2Range * WHEEL_ZOOM_FACTOR;
            const y2Val = plot.posToVal(top, 'y2');
            const ny2Min = y2Val - btmPct * ny2Range;
            plot.setScale('y2', { min: ny2Min, max: ny2Min + ny2Range });
          }
        } else {
          plot.setScale('y', {
            min: plot.scales.y.min!,
            max: plot.scales.y.max!,
          });
          if (plot.scales.y2) {
            plot.setScale('y2', {
              min: plot.scales.y2.min!,
              max: plot.scales.y2.max!,
            });
          }
        }
      });
    }

    over.addEventListener('mousedown', onMouseDown);
    over.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);

    return () => {
      over.removeEventListener('mousedown', onMouseDown);
      over.removeEventListener('wheel', onWheel);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
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
    const ext = fullExtentsRef.current;
    if (!plot || !ext) {
      return;
    }
    yAutoScaleRef.current = false;
    plot.batch(() => {
      plot.setScale('x', { min: ext.xMin, max: ext.xMax });
      plot.setScale('y', { min: ext.yMin, max: ext.yMax });
      if (plot.scales.y2) {
        plot.setScale('y2', { min: ext.yMin, max: ext.yMax });
      }
    });
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
      const savedY = { min: plot.scales.y.min!, max: plot.scales.y.max! };
      const savedY2 = plot.scales.y2
        ? { min: plot.scales.y2.min!, max: plot.scales.y2.max! }
        : null;
      yAutoScaleRef.current = true;
      plot.setSeries(seriesIdx, { show: !current });
      yAutoScaleRef.current = false;
      plot.batch(() => {
        plot.setScale('y', savedY);
        if (savedY2) {
          plot.setScale('y2', savedY2);
        }
      });

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
        <button
          type="button"
          className={styles.legendClearAll}
          onClick={() => checkedPaths.forEach(onRemovePath)}
        >
          Clear all
        </button>
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
