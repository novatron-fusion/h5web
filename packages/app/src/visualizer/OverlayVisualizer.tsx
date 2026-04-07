import {
  DataCurve,
  DefaultInteractions,
  ResetZoomButton,
  ScaleType,
  VisCanvas,
  extendDomain,
} from '@h5web/lib';
import { assertGroup } from '@h5web/shared/guards';
import { type Domain, type NumArray } from '@h5web/shared/vis-models';
import { Suspense, useMemo, useState } from 'react';
import { FiRefreshCw } from 'react-icons/fi';

import { useEntity, useValue } from '../hooks';
import { toNumArray } from '../vis-packs/core/utils';
import { assertNumericLikeNxData } from '../vis-packs/nexus/guards';
import { useNxData, usePrefetchNxValues } from '../vis-packs/nexus/hooks';
import styles from './OverlayVisualizer.module.css';
import visualizerStyles from './Visualizer.module.css';

const CURVE_COLORS = [
  '#1f77b4',
  '#ff7f0e',
  '#2ca02c',
  '#d62728',
  '#9467bd',
  '#8c564b',
  '#e377c2',
  '#7f7f7f',
  '#bcbd22',
  '#17becf',
];

interface CurveData {
  path: string;
  label: string;
  abscissas: NumArray;
  ordinates: NumArray;
  color: string;
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
  const key = checkedPaths.slice().sort().join('\n');

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

function useNxCurveData(path: string, colorIndex: number): CurveData {
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

  const signalData = toNumArray(signal)!;
  const abscissas: NumArray = xAxisValue
    ? toNumArray(xAxisValue)!
    : Array.from({ length: signalData.length }, (_, i) => i);

  return {
    path,
    label: signalDef.label || path.split('/').pop() || path,
    abscissas,
    ordinates: signalData,
    color: CURVE_COLORS[colorIndex % CURVE_COLORS.length],
  };
}

function OverlayChart(props: { checkedPaths: string[] }) {
  const { checkedPaths } = props;

  // This component is keyed so it remounts when checkedPaths set changes,
  // keeping the number of hook calls stable for each mount.
  const allCurves: CurveData[] = [];
  for (let i = 0; i < checkedPaths.length; i++) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    allCurves.push(useNxCurveData(checkedPaths[i], i));
  }

  const { abscissaDomain, ordinateDomain } = useMemo(() => {
    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;

    for (const curve of allCurves) {
      for (let i = 0; i < curve.abscissas.length; i++) {
        const x = Number(curve.abscissas[i]);
        const y = Number(curve.ordinates[i]);
        if (Number.isFinite(x)) {
          xMin = Math.min(xMin, x);
          xMax = Math.max(xMax, x);
        }
        if (Number.isFinite(y)) {
          yMin = Math.min(yMin, y);
          yMax = Math.max(yMax, y);
        }
      }
    }

    return {
      abscissaDomain: (Number.isFinite(xMin)
        ? extendDomain([xMin, xMax], 0.01)
        : [0, 1]) as Domain,
      ordinateDomain: (Number.isFinite(yMin)
        ? extendDomain([yMin, yMax], 0.05)
        : [0, 1]) as Domain,
    };
  }, [allCurves]);

  const [visibleCurves, setVisibleCurves] = useState<Record<string, boolean>>(
    () => Object.fromEntries(checkedPaths.map((p) => [p, true])),
  );

  return (
    <div className={styles.container}>
      <div className={styles.legend}>
        {allCurves.map((curve) => (
          <button
            key={curve.path}
            type="button"
            className={styles.legendItem}
            aria-pressed={visibleCurves[curve.path] !== false}
            onClick={() => {
              setVisibleCurves((prev: Record<string, boolean>) => ({
                ...prev,
                [curve.path]: !(prev[curve.path] ?? true),
              }));
            }}
          >
            <span
              className={styles.legendColor}
              style={{
                backgroundColor: curve.color,
                opacity: visibleCurves[curve.path] !== false ? 1 : 0.3,
              }}
            />
            <span
              className={styles.legendLabel}
              style={{
                opacity: visibleCurves[curve.path] !== false ? 1 : 0.5,
              }}
            >
              {curve.label}
            </span>
          </button>
        ))}
      </div>
      <div className={styles.chartArea}>
        <VisCanvas
          title="Overlay"
          abscissaConfig={{
            visDomain: abscissaDomain,
            showGrid: true,
            scaleType: ScaleType.Linear,
          }}
          ordinateConfig={{
            visDomain: ordinateDomain,
            showGrid: true,
            scaleType: ScaleType.Linear,
          }}
        >
          <DefaultInteractions />
          <ResetZoomButton />

          {allCurves.map((curve) => (
            <DataCurve
              key={curve.path}
              abscissas={curve.abscissas}
              ordinates={curve.ordinates}
              color={curve.color}
              visible={visibleCurves[curve.path] !== false}
            />
          ))}
        </VisCanvas>
      </div>
    </div>
  );
}

export default OverlayVisualizer;
