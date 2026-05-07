import { type NumArray } from '@h5web/shared/vis-models';

export interface NxCurveData {
  path: string;
  subsystem: string;
  label: string;
  unit: string | undefined;
  xLabel: string | undefined;
  abscissas: NumArray;
  ordinates: NumArray;
}

export interface LegendItem {
  seriesIdx: number;
  path: string;
  subsystem: string;
  label: string;
  color: string;
}

export interface LegendGroup {
  unit: string;
  items: LegendItem[];
}
