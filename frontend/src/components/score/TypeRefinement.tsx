/**
 * Type Refinement section — tagging-tool-design.md §7.2, ADR-011 §7.
 *
 * Shown above the property form when the selected concept has direct
 * IS_SUBTYPE_OF children whose CONTAINS structures differ from one another.
 * The backend determines structural divergence and returns only differing
 * children in the `type_refinements` array (Step 4 / getConceptSchemas).
 * An empty array means this section must NOT be rendered.
 *
 * Rendered as a compact radio group labelled with child concept names.
 * Selecting a refinement:
 *  - Updates the effective stage structure for Step 14 (stage bracket track).
 *  - Does NOT change the selected concept in the picker (parent stays selected).
 *  - Is stored alongside the concept in the submission payload (Step 18) so the
 *    server knows which subtype was identified.
 *
 * A structural choice is always a subtype split — never a property value. If
 * a property choice would change the stage layout that is a graph modelling
 * bug, not a UI case (ADR-011 §7 invariant).
 *
 * References: tagging-tool-design.md §7.2, ADR-011 §7.
 */

import { useTranslation } from 'react-i18next';
import type { TypeRefinementChild } from '../../services/conceptApi';
import Type from '../ui/Type';
import styles from './TypeRefinement.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TypeRefinementProps {
  /** Options provided by the schema tree. Must be non-empty for render. */
  options: TypeRefinementChild[];
  /** Id of the currently selected refinement, or null if none chosen. */
  selectedId: string | null;
  /** Called when the user selects or clears a refinement option. */
  onChange: (option: TypeRefinementChild | null) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders the Type Refinement radio group.
 *
 * Returns null (renders nothing) when options is empty — callers should check
 * options.length > 0 before rendering, but the guard here ensures correctness
 * regardless of call site.
 */
export default function TypeRefinement({ options, selectedId, onChange }: TypeRefinementProps) {
  const { t } = useTranslation('score');
  if (options.length === 0) return null;

  const handleChange = (option: TypeRefinementChild) => {
    if (option.id === selectedId) {
      // Clicking the already-selected option deselects (allows going back to
      // the unrefined parent concept for stage-bracket purposes).
      onChange(null);
    } else {
      onChange(option);
    }
  };

  return (
    <div className={styles.section} data-testid="type-refinement">
      <Type variant="label-sm" as="p" className={styles.label}>
        {t('typeRefinement.refineType')}
      </Type>
      <div
        className={styles.radioGroup}
        role="radiogroup"
        aria-label={t('typeRefinement.ariaLabel')}
        data-testid="type-refinement-group"
      >
        {options.map(option => {
          const isSelected = option.id === selectedId;
          return (
            <label
              key={option.id}
              className={[styles.radioLabel, isSelected ? styles.radioLabelSelected : '']
                .filter(Boolean)
                .join(' ')}
              data-testid={`refinement-option-${option.id}`}
            >
              <input
                type="radio"
                name="type-refinement"
                value={option.id}
                checked={isSelected}
                // onChange is required for controlled radio inputs; actual
                // selection logic runs in onClick so that clicking an already-
                // checked option (deselect) also triggers the handler —
                // onChange does not fire for already-checked radios in HTML.
                onChange={() => {}}
                onClick={() => handleChange(option)}
                className={styles.radioInput}
                aria-label={option.name}
              />
              <Type variant="label-md" as="span" className={styles.optionName}>
                {option.name}
              </Type>
            </label>
          );
        })}
      </div>
    </div>
  );
}
