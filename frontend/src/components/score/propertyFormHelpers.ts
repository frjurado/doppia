import type { PropertySchema } from '../../services/conceptApi';
import type { PropertyFormValues } from './PropertyForm';

export function computeIsComplete(
  schemas: PropertySchema[],
  values: PropertyFormValues,
): boolean {
  return schemas
    .filter(s => s.required)
    .every(s => {
      const v = values[s.id];
      if (v === null || v === undefined) return false;
      if (s.cardinality === 'MANY_OF') return Array.isArray(v) && v.length > 0;
      return true;
    });
}

export function carryOverValues(
  prevValues: PropertyFormValues,
  nextSchemas: PropertySchema[],
): PropertyFormValues {
  const nextIds = new Set(nextSchemas.map(s => s.id));
  const carried: PropertyFormValues = {};
  for (const [id, val] of Object.entries(prevValues)) {
    if (nextIds.has(id)) {
      carried[id] = val;
    }
  }
  return carried;
}
