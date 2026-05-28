/**
 * SubPartForm — inline concept + property form for a single stage sub-part tag.
 *
 * Rendered inside each stage card in StageList when the annotator expands the
 * "Tag analytically" section. The form is self-contained: it manages schema
 * loading state internally and notifies the parent (via onUpdate) whenever the
 * concept or properties change.
 *
 * The parent (ScoreViewer) owns the canonical SubPartTag state and clears it on
 * concept/refinement changes via the resetKey prop — when resetKey changes the
 * form resets to an empty state.
 *
 * Phase 1 scope: one visible level of nesting. Sub-sub-part forms are not
 * rendered (two-level display limit; ADR-011 §3).
 *
 * References: tagging-tool-design.md §5.4, ADR-011 §1 §3.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getConceptSchemas } from '../../services/conceptApi';
import type { ConceptSearchHit, ConceptSchemaTree } from '../../services/conceptApi';
import type { SubPartTag } from './stages';
import ConceptPicker from './ConceptPicker';
import PropertyForm from './PropertyForm';
import type { PropertyFormValues } from './PropertyForm';
import Type from '../ui/Type';
import styles from './SubPartForm.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SubPartFormProps {
  /** Stable identity for the stage this form tags. */
  stageId: string;
  /** Human-readable stage name shown in the remove-button aria-label. */
  stageName: string;
  /**
   * Initial tag when the form mounts (null = no tag yet). The form is
   * uncontrolled after mount; the parent clears by changing resetKey.
   */
  initialTag: SubPartTag | null;
  /**
   * Incremented by the parent to reset the form to empty state. Typical
   * trigger: the main concept or Type Refinement changes, making any
   * existing sub-part tags obsolete.
   */
  resetKey: number;
  /**
   * Called whenever the concept or properties change. Passes null when the
   * tag is cleared (concept deselected or Remove button clicked).
   */
  onUpdate: (stageId: string, tag: SubPartTag | null) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SubPartForm({
  stageId,
  stageName,
  initialTag,
  resetKey,
  onUpdate,
}: SubPartFormProps) {
  const [concept, setConcept] = useState<ConceptSearchHit | null>(initialTag?.concept ?? null);
  const [schemaTree, setSchemaTree] = useState<ConceptSchemaTree | null>(
    initialTag?.schemaTree ?? null,
  );
  const [propertyValues, setPropertyValues] = useState<PropertyFormValues>(
    initialTag?.propertyValues ?? {},
  );
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);

  // Stable refs so callbacks built during the async schema fetch read the
  // latest concept without stale closures.
  const conceptRef = useRef<ConceptSearchHit | null>(concept);
  const schemaTreeRef = useRef<ConceptSchemaTree | null>(schemaTree);

  // Reset all local state when the parent increments resetKey.
  const prevResetKeyRef = useRef(resetKey);
  if (prevResetKeyRef.current !== resetKey) {
    prevResetKeyRef.current = resetKey;
    // Synchronous state reset during render (avoids extra render round-trip
    // and prevents stale concept refs from firing onUpdate after reset).
    setConcept(null);
    setSchemaTree(null);
    setPropertyValues({});
    setSchemaError(null);
    setIsLoadingSchema(false);
    conceptRef.current = null;
    schemaTreeRef.current = null;
  }

  const handleConceptSelect = useCallback(
    async (selected: ConceptSearchHit | null) => {
      if (!selected) {
        setConcept(null);
        setSchemaTree(null);
        setPropertyValues({});
        setSchemaError(null);
        conceptRef.current = null;
        schemaTreeRef.current = null;
        onUpdate(stageId, null);
        return;
      }

      setConcept(selected);
      conceptRef.current = selected;
      setPropertyValues({});
      setSchemaError(null);

      setIsLoadingSchema(true);
      try {
        const tree = await getConceptSchemas(selected.id);
        // Guard: user may have already cleared the concept before the fetch
        // resolved. If so, conceptRef was set to null — discard this result.
        if (!conceptRef.current) return;
        setSchemaTree(tree);
        schemaTreeRef.current = tree;
        onUpdate(stageId, { concept: selected, schemaTree: tree, propertyValues: {} });
      } catch {
        if (!conceptRef.current) return;
        setSchemaError('Could not load schema. Try again.');
        schemaTreeRef.current = null;
        onUpdate(stageId, { concept: selected, schemaTree: null, propertyValues: {} });
      } finally {
        setIsLoadingSchema(false);
      }
    },
    [stageId, onUpdate],
  );

  const handlePropertyChange = useCallback(
    (vals: PropertyFormValues) => {
      setPropertyValues(vals);
      if (conceptRef.current) {
        onUpdate(stageId, {
          concept: conceptRef.current,
          schemaTree: schemaTreeRef.current,
          propertyValues: vals,
        });
      }
    },
    [stageId, onUpdate],
  );

  const handleRemove = useCallback(() => {
    setConcept(null);
    setSchemaTree(null);
    setPropertyValues({});
    setSchemaError(null);
    conceptRef.current = null;
    schemaTreeRef.current = null;
    onUpdate(stageId, null);
  }, [stageId, onUpdate]);

  // Keep refs in sync with state after external resets (resetKey path updates
  // refs synchronously above, but keep this as a fallback guard).
  useEffect(() => {
    conceptRef.current = concept;
    schemaTreeRef.current = schemaTree;
  }, [concept, schemaTree]);

  return (
    <div className={styles.form} data-testid={`sub-part-form-${stageId}`}>
      {/* Header row: "Sub-part tag" label + Remove button */}
      <div className={styles.header}>
        <Type variant="label-sm" as="span" className={styles.heading}>
          Sub-part tag
        </Type>
        {concept && (
          <button
            type="button"
            className={styles.removeBtn}
            onClick={handleRemove}
            aria-label={`Remove sub-part tag from ${stageName}`}
            data-testid={`sub-part-remove-${stageId}`}
          >
            Remove
          </button>
        )}
      </div>

      {/* Concept picker */}
      <ConceptPicker
        selectedConceptId={concept?.id ?? null}
        onSelect={handleConceptSelect}
      />

      {/* Schema loading / error status */}
      {isLoadingSchema && (
        <Type variant="label-sm" as="p" className={styles.status}>
          Loading schema…
        </Type>
      )}
      {schemaError && (
        <Type variant="label-sm" as="p" className={styles.error} role="alert">
          {schemaError}
        </Type>
      )}

      {/* Property form — rendered only when the concept has applicable schemas */}
      {schemaTree && schemaTree.schemas.length > 0 && (
        <PropertyForm
          schemas={schemaTree.schemas}
          values={propertyValues}
          onChange={handlePropertyChange}
        />
      )}
    </div>
  );
}
