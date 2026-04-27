import {
  KeepZoom,
  LineVis,
  ScaleType,
  useCombinedDomain,
  useDomain,
  useDomains,
} from '@h5web/lib';
import { assertGroup } from '@h5web/shared/guards';
import { type NumArray } from '@h5web/shared/vis-models';
import ndarray, { type NdArray } from 'ndarray';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { FiRefreshCw } from 'react-icons/fi';

import { useEntity, useValue } from '../hooks';
import { toNumArray } from '../vis-packs/core/utils';
import { assertNumericLikeNxData } from '../vis-packs/nexus/guards';
import { useNxData, usePrefetchNxValues } from '../vis-packs/nexus/hooks';
import styles from './OverlayVisualizer.module.css';
import visualizerStyles from './Visualizer.module.css';

// Fallback defaults (must match LineVis.module.css)
const DEFAULT_MAIN_COLOR = 'darkblue';
const DEFAULT_AUX_COLORS = [
  'orangered',
  'forestgreen',
  'red',
  'mediumorchid',
  'olive',
];

/**
 * Read the resolved line colors from the DOM via CSS custom properties.
 * This ensures the legend stays in sync with LineVis, even when the app
 * overrides --h5w-line--color / --h5w-line--colorAux (e.g. dark-mode).
 */
function useLineColors(ref: React.RefObject<HTMLElement | null>) {
  const [mainColor, setMainColor] = useState(DEFAULT_MAIN_COLOR);
  const [auxColors, setAuxColors] = useState(DEFAULT_AUX_COLORS);

  // Read after mount when the ref is attached
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }

    const cs = globalThis.getComputedStyle(el);

    const main = cs.getPropertyValue('--h5w-line--color').trim();
    if (main) {
      setMainColor(main);
    }

    const aux = cs.getPropertyValue('--h5w-line--colorAux').trim();
    if (aux) {
      setAuxColors(aux.split(',').map((c) => c.trim()));
    }
  }, [ref]);

  return { mainColor, auxColors };
}

interface NxCurveData {
  path: string;
  label: string;
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

  const ordinates = toNumArray(signal)!;
  const abscissas: NumArray = xAxisValue
    ? toNumArray(xAxisValue)!
    : Array.from({ length: ordinates.length }, (_, i) => i);

  return {
    path,
    label: signalDef.label || path.split('/').pop() || path,
    abscissas,
    ordinates,
  };
}

/**
 * Resample `srcY` (defined at `srcX`) onto `targetX` using linear interpolation.
 * Points outside the source range are set to NaN.
 */
function resampleToAxis(
  srcX: NumArray,
  srcY: NumArray,
  targetX: NumArray,
): number[] {
  const result = new Array<number>(targetX.length);

  for (let i = 0; i < targetX.length; i++) {
    const tx = Number(targetX[i]);

    // Binary search for the interval in srcX
    let lo = 0;
    let hi = srcX.length - 1;

    if (tx <= Number(srcX[lo])) {
      result[i] = tx === Number(srcX[lo]) ? Number(srcY[lo]) : Number.NaN;
      continue;
    }
    if (tx >= Number(srcX[hi])) {
      result[i] = tx === Number(srcX[hi]) ? Number(srcY[hi]) : Number.NaN;
      continue;
    }

    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (Number(srcX[mid]) <= tx) {
        lo = mid;
      } else {
        hi = mid;
      }
    }

    const x0 = Number(srcX[lo]);
    const x1 = Number(srcX[hi]);
    const t = (tx - x0) / (x1 - x0);
    result[i] = Number(srcY[lo]) * (1 - t) + Number(srcY[hi]) * t;
  }

  return result;
}

function OverlayChart(props: { checkedPaths: string[] }) {
  const { checkedPaths } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const { mainColor, auxColors } = useLineColors(containerRef);

  // Fetch all NX curve data (stable hook count because component is keyed)
  const allCurves: NxCurveData[] = [];
  for (let i = 0; i < checkedPaths.length; i++) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    allCurves.push(useNxCurveData(checkedPaths[i]));
  }

  // Use the curve with the most points as main (preserves most detail)
  const mainIndex = allCurves.reduce(
    (best, curve, i) =>
      curve.abscissas.length > allCurves[best].abscissas.length ? i : best,
    0,
  );
  const mainCurve = allCurves[mainIndex];
  const auxCurves = allCurves.filter((_, i) => i !== mainIndex);

  // Build main data as NdArray
  const mainArray = useMemo(
    () => ndarray(mainCurve.ordinates, [mainCurve.ordinates.length]),
    [mainCurve.ordinates],
  );

  // Build auxiliary NdArrays, resampled to main's x-axis if needed
  const auxArrays = useMemo(
    () =>
      auxCurves.map((aux) => {
        // Check if x-axes are identical (same length and same values)
        const sameAxis =
          aux.abscissas.length === mainCurve.abscissas.length &&
          aux.abscissas.every(
            (v, j) => Number(v) === Number(mainCurve.abscissas[j]),
          );

        if (sameAxis) {
          return ndarray(aux.ordinates, [aux.ordinates.length]);
        }

        // Different x-axis — resample to the main curve's x-axis
        const resampled = resampleToAxis(
          aux.abscissas,
          aux.ordinates,
          mainCurve.abscissas,
        );
        return ndarray(resampled, [resampled.length]);
      }),
    [auxCurves, mainCurve.abscissas],
  );

  const auxLabels = auxCurves.map((c) => c.label);

  // Visibility state
  const [mainVisible, setMainVisible] = useState(true);
  const [auxVisible, setAuxVisible] = useState<boolean[]>(() =>
    auxCurves.map(() => true),
  );

  // Domain computation (same as MappedLineVis)
  const mainDomain = useDomain(mainArray, { scaleType: ScaleType.Linear });
  const auxDomains = useDomains(auxArrays, {
    scaleType: ScaleType.Linear,
  });

  const combinedDomain = useCombinedDomain([
    mainVisible ? mainDomain : undefined,
    ...auxDomains.filter((_, i) => auxVisible[i]),
  ]);

  const abscissaParams = useMemo(
    () => ({ value: mainCurve.abscissas }),
    [mainCurve.abscissas],
  );

  const auxiliaries = useMemo(
    () =>
      auxArrays.map((array, i) => ({
        label: auxLabels[i],
        array,
        visible: auxVisible[i],
      })),
    [auxArrays, auxLabels, auxVisible],
  );

  return (
    <div ref={containerRef} className={styles.container}>
      <div className={styles.legend}>
        <button
          type="button"
          className={styles.legendItem}
          aria-pressed={mainVisible}
          onClick={() => setMainVisible((v) => !v)}
        >
          <span
            className={styles.legendColor}
            style={{
              backgroundColor: mainColor,
              opacity: mainVisible ? 1 : 0.3,
            }}
          />
          <span
            className={styles.legendLabel}
            style={{ opacity: mainVisible ? 1 : 0.5 }}
          >
            {mainCurve.label}
          </span>
        </button>
        {auxCurves.map((curve, i) => (
          <button
            key={curve.path}
            type="button"
            className={styles.legendItem}
            aria-pressed={auxVisible[i]}
            onClick={() => {
              setAuxVisible((prev) => {
                const next = [...prev];
                next[i] = !next[i];
                return next;
              });
            }}
          >
            <span
              className={styles.legendColor}
              style={{
                backgroundColor: auxColors[i % auxColors.length],
                opacity: auxVisible[i] ? 1 : 0.3,
              }}
            />
            <span
              className={styles.legendLabel}
              style={{ opacity: auxVisible[i] ? 1 : 0.5 }}
            >
              {curve.label}
            </span>
          </button>
        ))}
      </div>
      <LineVis
        className={styles.chartArea}
        dataArray={mainArray}
        domain={combinedDomain}
        scaleType={ScaleType.Linear}
        abscissaParams={abscissaParams}
        ordinateLabel="Signal"
        title="Overlay"
        auxiliaries={auxiliaries}
        visible={mainVisible}
        showGrid
      >
        <KeepZoom visKey="overlay" xOnly />
      </LineVis>
    </div>
  );
}

export default OverlayVisualizer;
