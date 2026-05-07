import { assertGroup } from '@h5web/shared/guards';

import { useEntity, useValue } from '../../hooks';
import { useDataContext } from '../../providers/DataProvider';
import { findScalarStrAttr, getAttributeValue } from '../../utils';
import { toNumArray } from '../../vis-packs/core/utils';
import { assertNumericLikeNxData } from '../../vis-packs/nexus/guards';
import { useNxData, usePrefetchNxValues } from '../../vis-packs/nexus/hooks';
import { type NxCurveData } from './models';
import { extractUnitFromLabel, stripUnitSuffix } from './utils';

export function useNxCurveData(path: string): NxCurveData {
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
  const abscissas = xAxisValue
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
