import { Suspense } from 'react';
import { FiRefreshCw } from 'react-icons/fi';

import OverlayChart from './overlay/OverlayChart';
import styles from './OverlayVisualizer.module.css';
import visualizerStyles from './Visualizer.module.css';

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

export default OverlayVisualizer;
