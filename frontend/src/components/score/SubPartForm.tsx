/**
 * SubPartForm — inline property form for a single stage's sub-part tag.
 *
 * Rendered inside each active stage card in StageList. The concept is implicit
 * from the stage bracket's graph metadata (stageConceptId = target_id from the
 * CONTAINS edge); there is no concept picker. The schema for stageConceptId is
 * fetched automatically on mount and renders a PropertyForm for optional
 * stage-level properties.
 *
 * If the stage concept has no applicable PropertySchemas, the form renders
 * nothing (zero schemas → no visible content). An unfilled or schema-less stage
 * still produces a child fragment with summary.properties: {} at submission.
 *
 * The parent (ScoreViewer) owns the canonical SubPartTag state. resetKey
 * increments clear the property values when the main concept changes.
 *
 * Phase 1 scope: one visible level of nesting (two-level display limit,
 * ADR-011 §3).
 *
 * References: tagging-tool-design.md §5.4, ADR-011 §1 §3.
 */

import { useEffect, useRef, useState } from 'react';
import { getConceptSchemas } from '../../services/conceptApi';
import type { ConceptSchemaTree } from '../../services/conceptApi';
import type { SubPartTag } from './stages';
import PropertyForm from './PropertyForm';
import type { PropertyFormValues } from './PropertyForm';
import Type from '../ui/Type';
import styles from './SubPartForm.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface SubPartFormProps {
  /** Stable identity for the stage this form tags; also the concept id. */
  stageId: string;
  /** Human-readable stage name for accessibility labels. */
  stageName: string;
  /**
   * The stage's implicit concept id (= stageId / target_id from CONTAINS edge).
   * Used to fetch the schema on mount. Never changes for a given stage.
   */
  stageConceptId: string;
  /**
   * Initial tag when the form mounts (null = no stored values). The form is
   * uncontrolled after mount; the parent clears by changing resetKey.
   */
  initialTag: SubPartTag | null;
  /**
   * Incremented by the parent to reset property values. Typical trigger: the
   * main concept or Type Refinement changes.
   */
  resetKey: number;
  /**
   * Called whenever property values change. Passes null only when resetKey
   * clears the form while the schema has not yet loaded.
   */
  onUpdate: (stageId: string, tag: SubPartTag | null) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SubPartForm({
  stageId,
  stageName,
  stageConceptId,
  initialTag,
  resetKey,
  onUpdate,
}: SubPartFormProps) {
  const [schemaTree, setSchemaTree] = useState<ConceptSchemaTree | null>(
    initialTag?.schemaTree ?? null,
  );
  const [propertyValues, setPropertyValues] = useState<PropertyFormValues>(
    initialTag?.propertyValues ?? {},
  );
  const [isLoading, setIsLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);

  // Track whether the schema fetch is still relevant (guards stale async results).
  const fetchIdRef = useRef(0);

  // Fetch schema on mount (or if stageConceptId ever changes, which it won't in
  // Phase 1 since stages are fixed after concept selection).
  useEffect(() => {
    // If initialTag already carries a fully loaded schema, skip the fetch.
    if (initialTag?.schemaTree) return;

    const fetchId = ++fetchIdRef.current;
    setIsLoading(true);
    setSchemaError(null);

    getConceptSchemas(stageConceptId)
      .then(tree => {
        if (fetchId !== fetchIdRef.current) return; // stale
        setSchemaTree(tree);
        // Notify parent with the loaded schema; property values stay as-is.
        onUpdate(stageId, { schemaTree: tree, propertyValues });
      })
      .catch(() => {
        if (fetchId !== fetchIdRef.current) return;
        setSchemaError('Could not load stage schema.');
      })
      .finally(() => {
        if (fetchId !== fetchIdRef.current) return;
        setIsLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageConceptId]);

  // Reset property values when the parent increments resetKey.
  const prevResetKeyRef = useRef(resetKey);
  if (prevResetKeyRef.current !== resetKey) {
    prevResetKeyRef.current = resetKey;
    setPropertyValues({});
    // Signal the parent that this stage's tag is now empty (schema stays if
    // already loaded — the stage concept hasn't changed, only the main concept
    // that triggered the reset).
    onUpdate(stageId, schemaTree ? { schemaTree, propertyValues: {} } : null);
  }

  const handlePropertyChange = (vals: PropertyFormValues) => {
    setPropertyValues(vals);
    if (schemaTree) {
      onUpdate(stageId, { schemaTree, propertyValues: vals });
    }
  };

  // Nothing to show while loading or if there are no schemas.
  if (isLoading) {
    return (
      <div className={styles.form} data-testid={`sub-part-form-${stageId}`}>
        <Type variant="label-sm" as="p" className={styles.status}>
          Loading…
        </Type>
      </div>
    );
  }

  if (schemaError) {
    return (
      <div className={styles.form} data-testid={`sub-part-form-${stageId}`}>
        <Type variant="label-sm" as="p" className={styles.error} role="alert">
          {schemaError}
        </Type>
      </div>
    );
  }

  if (!schemaTree || schemaTree.schemas.length === 0) {
    return null;
  }

  return (
    <div
      className={styles.form}
      data-testid={`sub-part-form-${stageId}`}
      aria-label={`Stage properties for ${stageName}`}
    >
      <Type variant="label-sm" as="span" className={styles.heading}>
        Stage properties
      </Type>
      <PropertyForm
        schemas={schemaTree.schemas}
        values={propertyValues}
        onChange={handlePropertyChange}
      />
    </div>
  );
}
