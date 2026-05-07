import 'uplot/dist/uPlot.min.css';

import { assertGroup } from '@h5web/shared/guards';
import { type NumArray } from '@h5web/shared/vis-models';
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { FiRefreshCw } from 'react-icons/fi';
import uPlot from 'uplot';

import { useEntity, useValue } from '../hooks';
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

interface NxCurveData {
  path: string;
  label: string;
  unit: string | undefined;
  xLabel: string | undefined;
  abscissas: NumArray;
  ordinates: NumArray;
}

interface Props {
  checkedPaths: string[];
}

function OverlayVisualizer(props: Props) {
  const { checkedPaths } = props;

  if (checkedPaths.length === 0) {
    return (
      <div className={visualizerStyles.fallback}>
        <p>No datasets selected for overlay</p>
        <p className={visualizerStyles.fallbackHint}>
          Check NXdata groups in the sidebar to overlay their signals.
        </p>
      </div>
    );
  }

  // Key on sorted paths so the component remounts when the set of paths changes.
  // This keeps the hook call count stable inside OverlayChart.
  const key = [...checkedPaths].sort().join('\n');

  return (
    <Suspense
      key={key}
      fallback={
        <div className={styles.loading}>
          <FiRefreshCw className={styles.spinner} />
          <p>Loading overlay data...</p>
        </div>
      }
    >
      <OverlayChart checkedPaths={checkedPaths} />
    </Suspense>
  );
}

function useNxCurveData(path: string): NxCurveData {
  const entity = useEntity(path);
  assertGroup(entity);

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

  return {
    path,
    label: signalDef.label || path.split('/').pop() || path,
    unit: signalDef.unit,
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
 * Build legend item descriptors grouped by unit.
 * Must be pure (no closure over mutable index) to satisfy lint.
 */
function buildLegendGroups(
  unitOrder: string[],
  unitMap: Map<string, NxCurveData[]>,
) {
  const groups: {
    unit: string;
    items: { seriesIdx: number; label: string; color: string }[];
  }[] = [];

  let globalIdx = 0;
  for (const unit of unitOrder) {
    const curves = unitMap.get(unit) ?? [];
    const items: { seriesIdx: number; label: string; color: string }[] = [];

    for (const curve of curves) {
      items.push({
        seriesIdx: globalIdx + 1, // +1 because series[0] is x-axis in uPlot
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
function OverlayChart(props: { checkedPaths: string[] }) {
  const { checkedPaths } = props;

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

  // Force-render trigger so the legend re-reads uPlot series visibility
  const [, forceRender] = useReducer((x: number) => x + 1, 0);

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
      });
    }

    return {
      width: 800,
      height: 400,
      series,
      scales,
      axes,
      legend: { show: false },
      cursor: {
        drag: { x: true, y: false, setScale: true },
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

  // Toggle series visibility via the uPlot API
  const toggleSeries = useCallback(
    (seriesIdx: number) => {
      const plot = uPlotRef.current;
      if (!plot) {
        return;
      }
      const current = plot.series[seriesIdx]?.show ?? true;
      plot.setSeries(seriesIdx, { show: !current });
      forceRender(); // re-read visibility for legend
    },
    [forceRender],
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
            {group.items.map((item) => {
              const isVisible =
                uPlotRef.current?.series[item.seriesIdx]?.show ?? true;

              return (
                <button
                  key={item.seriesIdx}
                  type="button"
                  className={styles.legendItem}
                  aria-pressed={isVisible}
                  onClick={() => toggleSeries(item.seriesIdx)}
                >
                  <span
                    className={styles.legendColor}
                    style={{
                      backgroundColor: item.color,
                      opacity: isVisible ? 1 : 0.3,
                    }}
                  />
                  <span
                    className={styles.legendLabel}
                    style={{ opacity: isVisible ? 1 : 0.5 }}
                  >
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div ref={chartRef} className={styles.chartArea} />
    </div>
  );
}

export default OverlayVisualizer;
