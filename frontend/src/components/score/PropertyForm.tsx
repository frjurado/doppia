/**
 * Property form — tagging-tool-design.md §7.4.
 *
 * Generated dynamically from the selected concept's PropertySchema list
 * (traversed up IS_SUBTYPE_OF in the backend). Requires no concept-specific
 * logic — the schema drives every control type and layout.
 *
 * Control types by cardinality:
 *  ONE_OF  → radio group (≤2 values) or compact single-select popover (>2 values)
 *  MANY_OF → checkbox group (≤2 values) or compact multi-select popover (>2 values)
 *  BOOL    → binary on/off toggle; null = never-touched initial state (ADR-019)
 *
 * Ordering (ADR-023): schemas are rendered in the order returned by the server,
 * which sorts by (grouped-first, order, name). Schemas sharing the same `group`
 * label are rendered as a contiguous cluster with a visible group label.
 * Required schemas are marked with * but are not separated from optional ones
 * by position — a required schema may appear inside the same group as optional ones.
 *
 * Values carrying VALUE_REFERENCES show an inline ⓘ button that expands a
 * definition panel inline below the option label.
 *
 * Form-state carryover: when the annotator changes the selected concept,
 * values for schemas shared by id are kept; others are discarded.
 * Call carryOverValues(prev, nextSchemas) in the parent when concept changes.
 *
 * References: tagging-tool-design.md §7.4, ADR-019, ADR-023.
 */

import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
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

// ---------------------------------------------------------------------------
// Internal sub-components
// ---------------------------------------------------------------------------

/** Field name label and optional description shown above each control. */
function FieldMeta({ schema }: { schema: PropertySchema }) {
  const { t } = useTranslation('score');
  const [descOpen, setDescOpen] = useState(false);

  return (
    <div className={styles.fieldMeta}>
      <span className={styles.fieldLabel}>
        <Type variant="label-sm" as="span">{schema.name}</Type>
        {schema.required && (
          <span className={styles.required} aria-label={t('requiredAria')}>*</span>
        )}
        {schema.description && (
          <button
            type="button"
            className={styles.descButton}
            aria-label={t('propertyForm.aboutAria', { name: schema.name })}
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

/**
 * OptionDropdown — compact popover used by ONE_OF (>2 values, single-select)
 * and MANY_OF (>2 values, multi-select).
 *
 * Trigger shows selected value name(s) or a count; clicking opens an absolutely-
 * positioned panel with the full option list. Closes on click-outside or Escape.
 */
interface OptionDropdownProps {
  schema: PropertySchema;
  value: PropertyFieldValue;
  /** true → MANY_OF multi-select; false → ONE_OF single-select. */
  multiple: boolean;
  onChange: (schemaId: string, val: PropertyFieldValue) => void;
}

function OptionDropdown({ schema, value, multiple, onChange }: OptionDropdownProps) {
  const { t } = useTranslation('score');
  const [open, setOpen] = useState(false);
  const [infoOpenId, setInfoOpenId] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const selectedIds: string[] = multiple
    ? (Array.isArray(value) ? value : [])
    : (typeof value === 'string' ? [value] : []);

  // Close on click outside.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  // Trigger label text.
  let triggerLabel: string;
  if (selectedIds.length === 0) {
    triggerLabel = t('propertyForm.selectPlaceholder');
  } else if (!multiple) {
    triggerLabel =
      schema.values.find(pv => pv.id === selectedIds[0])?.name ??
      t('propertyForm.selectPlaceholder');
  } else if (selectedIds.length <= 2) {
    triggerLabel = selectedIds
      .map(id => schema.values.find(pv => pv.id === id)?.name ?? id)
      .join(', ');
  } else {
    triggerLabel = t('propertyForm.countSelected', { count: selectedIds.length });
  }

  const handleOptionClick = (pvId: string) => {
    if (!multiple) {
      // ONE_OF: select → close; click selected → deselect.
      onChange(schema.id, selectedIds[0] === pvId ? null : pvId);
      setOpen(false);
    } else {
      // MANY_OF: toggle; keep popover open.
      const next = selectedIds.includes(pvId)
        ? selectedIds.filter(id => id !== pvId)
        : [...selectedIds, pvId];
      onChange(schema.id, next.length > 0 ? next : null);
    }
  };

  return (
    <div className={styles.field} data-testid={`field-${schema.id}`}>
      <FieldMeta schema={schema} />
      <div className={styles.optionDropdownWrapper} ref={wrapperRef}>
        <button
          type="button"
          className={styles.optionDropdownTrigger}
          onClick={() => setOpen(o => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          data-testid={`dropdown-trigger-${schema.id}`}
        >
          <span>{triggerLabel}</span>
          <span className={styles.optionDropdownChevron} aria-hidden="true">▾</span>
        </button>
        {open && (
          <div
            className={styles.optionDropdownPopover}
            role={multiple ? 'group' : 'listbox'}
            aria-label={schema.name}
            data-testid={`dropdown-popover-${schema.id}`}
          >
            {schema.values.map(pv => {
              const isSelected = selectedIds.includes(pv.id);
              const isInfoOpen = infoOpenId === pv.id;
              const hasRef = !!pv.referenced_concept;
              return (
                <div key={pv.id}>
                  <div
                    className={[
                      styles.optionLabel,
                      isSelected ? styles.optionLabelSelected : '',
                    ].filter(Boolean).join(' ')}
                    role={multiple ? 'checkbox' : 'option'}
                    aria-selected={isSelected}
                    aria-checked={multiple ? isSelected : undefined}
                    onClick={() => handleOptionClick(pv.id)}
                    data-testid={`dropdown-option-${schema.id}-${pv.id}`}
                  >
                    <Type
                      variant="label-md"
                      as="span"
                      className={isSelected ? styles.optionTextSelected : styles.optionText}
                    >
                      {pv.name}
                    </Type>
                    {hasRef && (
                      <button
                        type="button"
                        className={styles.infoButton}
                        aria-label={t('propertyForm.infoAria', { name: pv.referenced_concept!.name })}
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
                  </div>
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
        )}
      </div>
    </div>
  );
}

/** ONE_OF: radio group (≤2 values) or compact single-select popover (>2 values). */
function OneOfField({ schema, value, onChange }: FieldProps) {
  const { t } = useTranslation('score');
  const [infoOpenId, setInfoOpenId] = useState<string | null>(null);
  const selected = typeof value === 'string' ? value : null;

  if (schema.values.length > 2) {
    return <OptionDropdown schema={schema} value={value} multiple={false} onChange={onChange} />;
  }

  // Radio group for ≤2 values.
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
                    aria-label={t('propertyForm.infoAria', { name: pv.referenced_concept!.name })}
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

/** MANY_OF: checkbox group (≤2 values) or compact multi-select popover (>2 values). */
function ManyOfField({ schema, value, onChange }: FieldProps) {
  const { t } = useTranslation('score');
  const [infoOpenId, setInfoOpenId] = useState<string | null>(null);
  const selected: string[] = Array.isArray(value) ? value : [];

  if (schema.values.length > 2) {
    return <OptionDropdown schema={schema} value={value} multiple={true} onChange={onChange} />;
  }

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
                    aria-label={t('propertyForm.infoAria', { name: pv.referenced_concept!.name })}
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
 * BOOL: compact inline toggle.
 *
 * Starts null (unset — never touched). After the first click cycles true ↔ false
 * and never returns to null. Null and false share the same "off" visual so the
 * toggle looks binary to the user; the null/false distinction is preserved in the
 * payload for optional semantics but is not surfaced visually.
 *
 *  null  → "✗" (off appearance — unset, safe to submit for optional schemas)
 *  true  → "✓" (primary background)
 *  false → "✗" (off appearance — explicitly no)
 */
function BoolField({ schema, value, onChange }: FieldProps) {
  const { t } = useTranslation('score');
  const current = typeof value === 'boolean' ? value : null;
  const nextValue: boolean | null =
    current === null ? true : current === true ? false : true;
  const indicator = current === true ? '✓' : '✗';

  return (
    <div className={styles.boolInlineField} data-testid={`field-${schema.id}`}>
      <button
        type="button"
        className={`${styles.boolToggle} ${current === true ? styles.boolToggleOn : styles.boolToggleOff}`}
        onClick={() => onChange(schema.id, nextValue)}
        aria-label={t('propertyForm.boolAria', {
          name: schema.name,
          state:
            current === null
              ? t('propertyForm.unset')
              : current
                ? t('propertyForm.yes')
                : t('propertyForm.no'),
        })}
        data-testid={`bool-toggle-${schema.id}`}
      >
        {indicator}
      </button>
      <FieldMeta schema={schema} />
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

// ---------------------------------------------------------------------------
// Group schemas into contiguous sections by their `group` label (ADR-023).
// The server already delivers schemas in (grouped-first, order, name) order;
// we only need to detect group boundaries and cluster them visually.
// ---------------------------------------------------------------------------

interface SchemaSection {
  group: string | null;
  schemas: PropertySchema[];
}

function groupSchemas(schemas: PropertySchema[]): SchemaSection[] {
  const sections: SchemaSection[] = [];
  for (const schema of schemas) {
    const groupKey = schema.group ?? null;
    const last = sections[sections.length - 1];
    if (last && last.group === groupKey) {
      last.schemas.push(schema);
    } else {
      sections.push({ group: groupKey, schemas: [schema] });
    }
  }
  return sections;
}

export default function PropertyForm({ schemas, values, onChange }: PropertyFormProps) {
  if (schemas.length === 0) return null;

  const sections = groupSchemas(schemas);

  const handleFieldChange = (schemaId: string, val: PropertyFieldValue) => {
    onChange({ ...values, [schemaId]: val });
  };

  return (
    <div className={styles.form} data-testid="property-form">
      {sections.map(section => (
        <div
          key={section.group ?? '__ungrouped'}
          className={section.group ? styles.group : styles.ungrouped}
          data-testid={section.group ? `group-${section.group}` : 'ungrouped-properties'}
        >
          {section.group && (
            <Type variant="label-sm" as="span" className={styles.groupLabel}>
              {section.group}
            </Type>
          )}
          {section.schemas.map(schema => (
            <SchemaField
              key={schema.id}
              schema={schema}
              value={values[schema.id] ?? null}
              onChange={handleFieldChange}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
