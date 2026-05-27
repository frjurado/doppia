/**
 * Form panel — tagging-tool-design.md §7.
 *
 * The right-hand panel of the tagging interface. Hosts:
 *   §7.1 ConceptPicker  — search, domain facets, hierarchy-path display
 *   §7.2 TypeRefinement — radio group when children differ structurally
 *   (Steps 13–18 add Stage list, Property form, Harmony panel, Prose field,
 *    Submission checklist in subsequent steps.)
 *
 * State ownership:
 *   selectedConcept  — this component; clears on concept deselect
 *   schemaTree       — fetched after concept selection; null while loading
 *   selectedRefinement — clears whenever the selected concept changes
 *
 * Session wiring:
 *   session.setConceptSet(true/false) is called immediately on concept
 *   selection/deselection. For Step 12 this is the only session flag managed
 *   here; stagesComplete and propertiesComplete are wired in Steps 14 and 13.
 *
 * Callbacks to parent (ScoreViewer):
 *   onConceptChange — fires after schema tree is fetched; receives the
 *     concept hit and the full ConceptSchemaTree so Step 14 can pre-populate
 *     stage brackets without a second API call.
 *   onRefinementChange — fires when a refinement option is selected/cleared.
 *
 * References: tagging-tool-design.md §2 §7, ADR-011 §2 §7.
 */

import { useCallback, useEffect, useState } from 'react';
import { getConceptSchemas } from '../../services/conceptApi';
import type {
  ConceptSchemaTree,
  ConceptSearchHit,
  TypeRefinementChild,
} from '../../services/conceptApi';
import type { AnnotationSession } from './annotator';
import type { AnnotationFlags } from './annotator';
import ConceptPicker from './ConceptPicker';
import TypeRefinement from './TypeRefinement';
import Type from '../ui/Type';
import styles from './FormPanel.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FormPanelProps {
  /**
   * The live annotation session. Null while the ghost layer is rebuilding
   * (between renders). FormPanel disables setConceptSet calls when null.
   */
  session: AnnotationSession | null;
  /** Current concurrent flags — used to conditionally show/hide sections. */
  flags: AnnotationFlags;
  /**
   * Called after the schema tree for the selected concept is fetched.
   * Receives null for both arguments when the concept is cleared.
   * Step 14 consumes schemaTree.stage_structure for bracket pre-population.
   */
  onConceptChange?: (
    concept: ConceptSearchHit | null,
    schemaTree: ConceptSchemaTree | null,
  ) => void;
  /**
   * Called when the annotator selects or clears a Type Refinement option.
   * Step 14 fetches the child's stage structure via getConceptSchemas(child.id).
   */
  onRefinementChange?: (option: TypeRefinementChild | null) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function FormPanel({
  session,
  flags,
  onConceptChange,
  onRefinementChange,
}: FormPanelProps) {
  const [selectedConcept, setSelectedConcept] = useState<ConceptSearchHit | null>(null);
  const [schemaTree, setSchemaTree] = useState<ConceptSchemaTree | null>(null);
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [selectedRefinement, setSelectedRefinement] = useState<TypeRefinementChild | null>(null);

  // When the session rebuilds (ghost layer re-render), any previously-set
  // conceptSet flag on the old session is already gone. Re-apply it to the new
  // session so the checklist stays coherent.
  useEffect(() => {
    if (!session) return;
    session.setConceptSet(selectedConcept !== null);
  }, [session, selectedConcept]);

  const handleConceptSelect = useCallback(
    async (concept: ConceptSearchHit | null) => {
      setSelectedConcept(concept);
      setSelectedRefinement(null);  // refinement resets whenever concept changes
      onRefinementChange?.(null);

      if (!concept) {
        session?.setConceptSet(false);
        setSchemaTree(null);
        setSchemaError(null);
        onConceptChange?.(null, null);
        return;
      }

      // Optimistically set conceptSet so the checklist updates immediately;
      // if the schema fetch fails we will leave conceptSet true (the concept
      // is still selected, just without a schema tree yet).
      session?.setConceptSet(true);

      setIsLoadingSchema(true);
      setSchemaError(null);
      try {
        const tree = await getConceptSchemas(concept.id);
        setSchemaTree(tree);
        onConceptChange?.(concept, tree);
      } catch {
        setSchemaError('Could not load concept schema. Try again.');
        setSchemaTree(null);
        onConceptChange?.(concept, null);
      } finally {
        setIsLoadingSchema(false);
      }
    },
    [session, onConceptChange, onRefinementChange],
  );

  const handleRefinementChange = useCallback(
    (option: TypeRefinementChild | null) => {
      setSelectedRefinement(option);
      onRefinementChange?.(option);
    },
    [onRefinementChange],
  );

  const typeRefinements = schemaTree?.type_refinement.children ?? [];

  return (
    <aside className={styles.panel} aria-label="Annotation form">
      {/* ── Section: Concept ─────────────────────────────────────────── */}
      <section className={styles.section}>
        <Type variant="label-sm" as="h2" className={styles.sectionHeading}>
          Concept
        </Type>
        <ConceptPicker
          selectedConceptId={selectedConcept?.id ?? null}
          onSelect={handleConceptSelect}
        />
        {isLoadingSchema && (
          <Type variant="label-sm" as="p" className={styles.schemaStatus}>
            Loading schema…
          </Type>
        )}
        {schemaError && (
          <Type variant="label-sm" as="p" className={styles.schemaError} role="alert">
            {schemaError}
          </Type>
        )}
      </section>

      {/* ── Section: Type Refinement ─────────────────────────────────── */}
      {/* Rendered only when the concept has structurally-divergent subtypes
          (ADR-011 §7). The backend excludes children that differ only in
          property values — no front-end structural-divergence check needed. */}
      {typeRefinements.length > 0 && (
        <section className={styles.section}>
          <TypeRefinement
            options={typeRefinements}
            selectedId={selectedRefinement?.id ?? null}
            onChange={handleRefinementChange}
          />
        </section>
      )}

      {/* ── Placeholder for Steps 13–18 ──────────────────────────────── */}
      {/* Stage list (Step 14), property form (Step 13), harmony panel (Step 16),
          prose field (Step 17), and submission checklist (Step 18) are added in
          their respective steps. The fragmentSet check below keeps the panel
          quiet until a main bracket exists, matching the design's intent that
          classification is anchored to a committed selection. */}
      {!flags.fragmentSet && (
        <div className={styles.noSelectionHint}>
          <Type variant="label-sm" as="p" className={styles.hintText}>
            Draw a selection on the score to begin tagging.
          </Type>
        </div>
      )}
    </aside>
  );
}
