import { Btn, LinkBtn, Separator, ToggleBtn, ToggleGroup } from '@h5web/lib';
import { useEventListener, useRerender } from '@react-hookz/web';
import {
  FiMaximize,
  FiMessageCircle,
  FiMinimize,
  FiSidebar,
} from 'react-icons/fi';

import { type ViewerMode } from '../App';
import { useDataContext } from '../providers/DataProvider';
import Breadcrumbs from './Breadcrumbs';
import styles from './BreadcrumbsBar.module.css';
import { type FeedbackContext } from './models';

interface Props {
  path: string;
  isSidebarOpen: boolean;
  viewerMode: ViewerMode;
  onToggleSidebar: () => void;
  onChangeViewerMode: (mode: ViewerMode) => void;
  onSelectPath: (path: string) => void;
  getFeedbackURL?: (context: FeedbackContext) => string;
}

function BreadcrumbsBar(props: Props) {
  const {
    path,
    isSidebarOpen,
    viewerMode,
    onToggleSidebar,
    onChangeViewerMode,
    onSelectPath,
    getFeedbackURL,
  } = props;

  const { filepath } = useDataContext();
  const isFullscreen = !!document.fullscreenElement;

  const rerender = useRerender();
  useEventListener(document, 'fullscreenchange', rerender);

  return (
    <div className={styles.bar}>
      <ToggleBtn
        label="Toggle sidebar"
        Icon={FiSidebar}
        iconOnly
        value={isSidebarOpen}
        onToggle={onToggleSidebar}
      />

      <Separator className={styles.sep} />

      <Breadcrumbs
        path={path}
        onSelect={onSelectPath}
        showFilename={!isSidebarOpen}
      />

      <ToggleGroup
        role="tablist"
        ariaLabel="Viewer mode"
        value={viewerMode}
        onChange={(val) => {
          onChangeViewerMode(val as ViewerMode);
        }}
      >
        <ToggleGroup.Btn label="Display" value="display" />
        <ToggleGroup.Btn label="Inspect" value="inspect" />
        <ToggleGroup.Btn label="Overlay" value="overlay" />
      </ToggleGroup>

      {document.fullscreenEnabled && (
        <Btn
          Icon={isFullscreen ? FiMinimize : FiMaximize}
          iconOnly
          label="Go full screen"
          onClick={() => {
            if (!document.fullscreenElement) {
              void document
                .querySelector('[data-fullscreen-root]')
                ?.requestFullscreen();
            } else {
              void document.exitFullscreen();
            }
          }}
        />
      )}

      {getFeedbackURL && (
        <>
          <Separator />
          <LinkBtn
            label="Feedback"
            icon={FiMessageCircle}
            href="/" // replaced dynamically
            target="_blank"
            onClick={(evt) => {
              const feedbackUrl = getFeedbackURL({
                filePath: filepath,
                entityPath: path,
              });

              evt.currentTarget.setAttribute('href', feedbackUrl);
            }}
          />
        </>
      )}
    </div>
  );
}

export default BreadcrumbsBar;
