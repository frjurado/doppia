/**
 * Property form — tagging-tool-design.md §7.4.
 *
 * Generated dynamically from the selected concept's PropertySchema list
 * (traversed up IS_SUBTYPE_OF in the backend). Requires no concept-specific
 * logic — the schema drives every control type and layout.
 *
 * Control types by cardinality:
 *  ONE_OF  → radio group (≤5 values) or select dropdown (>5 values)
 *  MANY_OF → checkbox group
 *  BOOL    → Yes / No toggle; null = unset (ADR-019; no value list)
 *
 * Required properties appear first; optional after, visually separated.
 * A missing required value blocks submission via the propertiesComplete flag
 * (the parent calls session.setPropertiesComplete via computeIsComplete).
 *
 * Values carrying VALUE_REFERENCES show an inline ⓘ button that expands a
 * definition panel inline below the option label.
 *
 * Form-state carryover: when the annotator changes the selected concept,
 * values for schemas shared by id are kept; others are discarded.
 * Call carryOverValues(prev, nextSchemas) in the parent when concept changes.
 *
 * References: tagging-tool-design.md §7.4, ADR-019.
 */

import { useState } from 'react';
import type { PropertySchema } from '../../services/conceptApi';
import Type from '../ui/Type';
import styles from './PropertyForm.module.css';

// ---------------------------------------------------------------------------
// Exported types and helpers
// ---------------------------------------------------------------------------

/** Value for a single PropertySchema field in the form state. */
export type PropertyFieldValue = string | string[] | boolean | null;

/** Map from PropertySchema.id to its current value. Owned by FormPanel. */
export type PropertyFormValues = Record<string, PropertyFieldValue>;

export interface PropertyFormProps {
  /** All applicable schemas for the concept, inherited via IS_SUBTYPE_OF. */
  schemas: PropertySchema[];
  /** Current form values keyed by schema id. */
  values: PropertyFormValues;
  /** Called with the full updated values map whenever any field changes. */
  onChange: (values: PropertyFormValues) => void;
}

/**
 * Returns true when every required schema has a non-null, non-empty value.
 * Trivially true when there are no required schemas (§8 stageless concepts).
 *
 * BOOL: null = unset → blocks; true/false = explicitly set → passes.
 * ONE_OF: null = unset → blocks; non-null string → passes.
 * MANY_OF: null or empty array → blocks; ≥1 item → passes.
 */
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
      // ONE_OF: any non-null string; BOOL: any explicit boolean (covered above)
      return true;
    });
}

/**
 * Builds a new values map carrying over only entries whose schema id appears
 * in nextSchemas. Values for schemas that no longer apply are discarded.
 * Call this in FormPanel whenever the selected concept changes.
 */
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

// ---------------------------------------------------------------------------
// Internal sub-components
// ---------------------------------------------------------------------------

/** Field name label and optional description shown above each control. */
function FieldMeta({ schema }: { schema: PropertySchema }) {
  const [descOpen, setDescOpen] = useState(false);

  return (
    <div className={styles.fieldMeta}>
      <span className={styles.fieldLabel}>
        <Type variant="label-sm" as="span">{schema.name}</Type>
        {schema.required && (
          <span className={styles.required} aria-label="required">*</span>
        )}
        {schema.description && (
          <button
            type="button"
            className={styles.descButton}
            aria-label={`About: ${schema.name}`}
            aria-expanded={descOpen}
            onMouseEnter={() => setDescOpen(true)}
            onMouseLeave={() => setDescOpen(false)}
            onClick={() => setDescOpen(o => !o)}
            data-testid={`desc-btn-${schema.id}`}
          >
            ⓘ
          </button>
        )}
      </span>
      {schema.description && descOpen && (
        <div
          className={styles.descFloating}
          role="tooltip"
          data-testid={`desc-panel-${schema.id}`}
        >
          <Type variant="label-sm" as="span">
            {schema.description}
          </Type>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field components
// ---------------------------------------------------------------------------

interface FieldProps {
  schema: PropertySchema;
  value: PropertyFieldValue;
  onChange: (schemaId: string, val: PropertyFieldValue) => void;
}

/** ONE_OF: radio group (≤5 values) or select dropdown (>5 values). */
function OneOfField({ schema, value, onChange }: FieldProps) {
  const [infoOpenId, setInfoOpenId] = useState<string | null>(null);
  const selected = typeof value === 'string' ? value : null;

  // Select dropdown for schemas with more than 5 options.
  if (schema.values.length > 5) {
    return (
      <div className={styles.field} data-testid={`field-${schema.id}`}>
        <FieldMeta schema={schema} />
        <select
          className={styles.select}
          value={selected ?? ''}
          onChange={e => onChange(schema.id, e.target.value || null)}
          data-testid={`select-${schema.id}`}
          aria-label={schema.name}
        >
          <option value="">— select —</option>
          {schema.values.map(pv => (
            <option key={pv.id} value={pv.id}>{pv.name}</option>
          ))}
        </select>
      </div>
    );
  }

  // Radio group for ≤5 values.
  return (
    <div className={styles.field} data-testid={`field-${schema.id}`}>
      <FieldMeta schema={schema} />
      <div className={styles.optionGroup} role="radiogroup" aria-label={schema.name}>
        {schema.values.map(pv => {
          const isChecked = selected === pv.id;
          const isInfoOpen = infoOpenId === pv.id;
          const hasRef = !!pv.referenced_concept;
          return (
            <div key={pv.id}>
              <label
                className={[
                  styles.optionLabel,
                  isChecked ? styles.optionLabelSelected : '',
                ].filter(Boolean).join(' ')}
                data-testid={`radio-${schema.id}-${pv.id}`}
              >
                <input
                  type="radio"
                  name={schema.id}
                  value={pv.id}
                  checked={isChecked}
                  onChange={() => {}}
                  onClick={() => onChange(schema.id, isChecked ? null : pv.id)}
                  className={styles.hiddenInput}
                  aria-label={pv.name}
                />
                <Type
                  variant="label-md"
                  as="span"
                  className={isChecked ? styles.optionTextSelected : styles.optionText}
                >
                  {pv.name}
                </Type>
                {hasRef && (
                  <button
                    type="button"
                    className={styles.infoButton}
                    aria-label={`Info: ${pv.referenced_concept!.name}`}
                    aria-expanded={isInfoOpen}
                    onClick={e => {
                      e.stopPropagation();
                      setInfoOpenId(isInfoOpen ? null : pv.id);
                    }}
                    data-testid={`info-btn-${pv.id}`}
                  >
                    ⓘ
                  </button>
                )}
              </label>
              {hasRef && isInfoOpen && (
                <div
                  className={styles.infoPanel}
                  data-testid={`info-panel-${pv.id}`}
                >
                  <Type variant="label-md" as="span" className={styles.infoTitle}>
                    {pv.referenced_concept!.name}
                  </Type>
                  {pv.referenced_concept!.definition && (
                    <Type variant="label-sm" as="span" className={styles.infoDef}>
                      {pv.referenced_concept!.definition}
                    </Type>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** MANY_OF: checkbox group. */
function ManyOfField({ schema, value, onChange }: FieldProps) {
  const [infoOpenId, setInfoOpenId] = useState<string | null>(null);
  const selected: string[] = Array.isArray(value) ? value : [];

  const toggle = (pvId: string) => {
    const next = selected.includes(pvId)
      ? selected.filter(id => id !== pvId)
      : [...selected, pvId];
    onChange(schema.id, next.length > 0 ? next : null);
  };

  return (
    <div className={styles.field} data-testid={`field-${schema.id}`}>
      <FieldMeta schema={schema} />
      <div className={styles.optionGroup} role="group" aria-label={schema.name}>
        {schema.values.map(pv => {
          const isChecked = selected.includes(pv.id);
          const isInfoOpen = infoOpenId === pv.id;
          const hasRef = !!pv.referenced_concept;
          return (
            <div key={pv.id}>
              <label
                className={[
                  styles.optionLabel,
                  isChecked ? styles.optionLabelSelected : '',
                ].filter(Boolean).join(' ')}
                data-testid={`checkbox-${schema.id}-${pv.id}`}
              >
                <input
                  type="checkbox"
                  className={styles.hiddenInput}
                  checked={isChecked}
                  onChange={() => toggle(pv.id)}
                  aria-label={pv.name}
                />
                <Type
                  variant="label-md"
                  as="span"
                  className={isChecked ? styles.optionTextSelected : styles.optionText}
                >
                  {pv.name}
                </Type>
                {hasRef && (
                  <button
                    type="button"
                    className={styles.infoButton}
                    aria-label={`Info: ${pv.referenced_concept!.name}`}
                    aria-expanded={isInfoOpen}
                    onClick={e => {
                      e.stopPropagation();
                      setInfoOpenId(isInfoOpen ? null : pv.id);
                    }}
                    data-testid={`info-btn-${pv.id}`}
                  >
                    ⓘ
                  </button>
                )}
              </label>
              {hasRef && isInfoOpen && (
                <div
                  className={styles.infoPanel}
                  data-testid={`info-panel-${pv.id}`}
                >
                  <Type variant="label-md" as="span" className={styles.infoTitle}>
                    {pv.referenced_concept!.name}
                  </Type>
                  {pv.referenced_concept!.definition && (
                    <Type variant="label-sm" as="span" className={styles.infoDef}>
                      {pv.referenced_concept!.definition}
                    </Type>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * BOOL: Yes / No toggle pair.
 *
 * Neither pressed = null (unset). Clicking the active button returns to null,
 * matching the radio deselect pattern used in TypeRefinement and OneOfField.
 * Required BOOL schemas must be explicitly set to true or false; null blocks.
 */
function BoolField({ schema, value, onChange }: FieldProps) {
  const current = typeof value === 'boolean' ? value : null;

  return (
    <div className={styles.field} data-testid={`field-${schema.id}`}>
      <FieldMeta schema={schema} />
      <div className={styles.boolRow}>
        <button
          type="button"
          className={[
            styles.boolOption,
            current === true ? styles.boolOptionSelected : '',
          ].filter(Boolean).join(' ')}
          onClick={() => onChange(schema.id, current === true ? null : true)}
          aria-pressed={current === true}
          data-testid={`bool-yes-${schema.id}`}
        >
          <Type
            variant="label-md"
            as="span"
            className={current === true ? styles.optionTextSelected : styles.optionText}
          >
            Yes
          </Type>
        </button>
        <button
          type="button"
          className={[
            styles.boolOption,
            current === false ? styles.boolOptionSelected : '',
          ].filter(Boolean).join(' ')}
          onClick={() => onChange(schema.id, current === false ? null : false)}
          aria-pressed={current === false}
          data-testid={`bool-no-${schema.id}`}
        >
          <Type
            variant="label-md"
            as="span"
            className={current === false ? styles.optionTextSelected : styles.optionText}
          >
            No
          </Type>
        </button>
      </div>
    </div>
  );
}

/** Dispatches to the correct field component based on schema cardinality. */
function SchemaField({ schema, value, onChange }: FieldProps) {
  if (schema.cardinality === 'BOOL') {
    return <BoolField schema={schema} value={value} onChange={onChange} />;
  }
  if (schema.cardinality === 'MANY_OF') {
    return <ManyOfField schema={schema} value={value} onChange={onChange} />;
  }
  return <OneOfField schema={schema} value={value} onChange={onChange} />;
}

// ---------------------------------------------------------------------------
// PropertyForm
// ---------------------------------------------------------------------------

export default function PropertyForm({ schemas, values, onChange }: PropertyFormProps) {
  if (schemas.length === 0) return null;

  const required = schemas.filter(s => s.required);
  const optional = schemas.filter(s => !s.required);

  const handleFieldChange = (schemaId: string, val: PropertyFieldValue) => {
    onChange({ ...values, [schemaId]: val });
  };

  return (
    <div className={styles.form} data-testid="property-form">
      {required.length > 0 && (
        <div className={styles.group} data-testid="required-properties">
          <Type variant="label-sm" as="span" className={styles.groupLabel}>
            Required
          </Type>
          {required.map(schema => (
            <SchemaField
              key={schema.id}
              schema={schema}
              value={values[schema.id] ?? null}
              onChange={handleFieldChange}
            />
          ))}
        </div>
      )}
      {optional.length > 0 && (
        <div className={styles.group} data-testid="optional-properties">
          <Type variant="label-sm" as="span" className={styles.groupLabel}>
            Optional
          </Type>
          {optional.map(schema => (
            <SchemaField
              key={schema.id}
              schema={schema}
              value={values[schema.id] ?? null}
              onChange={handleFieldChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}
