/**
 * Form panel — tagging-tool-design.md §7.
 *
 * The right-hand panel of the tagging interface. Hosts:
 *   §7.1 ConceptPicker  — search, domain facets, hierarchy-path display
 *   §7.2 TypeRefinement — radio group when children differ structurally
 *   §7.3 StageList      — stage cards with bounds display and absent toggle
 *   §7.4 PropertyForm   — dynamic property form driven by schema tree (Step 13)
 *   (Steps 16–18 add Harmony panel, Prose field, Submission checklist.)
 *
 * State ownership:
 *   selectedConcept    — this component; clears on concept deselect
 *   schemaTree         — fetched after concept selection; null while loading
 *   selectedRefinement — clears whenever the selected concept changes
 *   propertyValues     — this component; carries over shared values on concept
 *                        change; cleared on concept deselect (Step 13)
 *
 * Session wiring:
 *   session.setConceptSet(true/false) — on concept selection/deselection
 *   session.setPropertiesComplete(bool) — whenever propertyValues or
 *     schemaTree changes; computed by computeIsComplete (Step 13)
 *
 * Callbacks to parent (ScoreViewer):
 *   onConceptChange — fires after schema tree is fetched; receives the
 *     concept hit and the full ConceptSchemaTree so Step 14 can pre-populate
 *     stage brackets without a second API call.
 *   onRefinementChange — fires when a refinement option is selected/cleared.
 *
 * Stage props (Step 14):
 *   assignments       — stage assignments owned by ScoreViewer; passed through
 *                       for display in StageList.
 *   activeStageId     — which stage is currently active (score ↔ form sync).
 *   onStageActivate   — fires when user clicks a stage card.
 *   onToggleAbsent    — fires when user toggles a stage's absent checkbox.
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
import type { StageAssignment, SubPartTag } from './stages';
import ConceptPicker from './ConceptPicker';
import TypeRefinement from './TypeRefinement';
import StageList from './StageList';
import PropertyForm from './PropertyForm';
import type { PropertyFormValues } from './PropertyForm';
import { carryOverValues, computeIsComplete } from './propertyFormHelpers';
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
   * Step 14 consumes schemaTree.stages for bracket pre-population.
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

  // ── Step 14: Stage bracket state passed down from ScoreViewer ─────────────

  /** Stage assignments owned by ScoreViewer; displayed in the stage list. */
  assignments?: StageAssignment[];
  /** Currently active stage (bidirectional score ↔ form highlighting). */
  activeStageId?: string | null;
  /** Called when the annotator clicks a stage card to activate it. */
  onStageActivate?: (stageId: string | null) => void;
  /** Called when the annotator toggles a stage's absent checkbox. */
  onToggleAbsent?: (stageId: string, absent: boolean) => void;

  // ── Step 15: Sub-part tags passed down from ScoreViewer ────────────────────

  /** Current sub-part tags keyed by stageId; owned by ScoreViewer. */
  subPartTags?: Record<string, SubPartTag | null>;
  /** Called when a stage's sub-part tag is created, updated, or removed. */
  onSubPartTagUpdate?: (stageId: string, tag: SubPartTag | null) => void;
  /** Incremented when all sub-part forms should reset (concept change). */
  subPartResetKey?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function FormPanel({
  session,
  flags,
  onConceptChange,
  onRefinementChange,
  assignments = [],
  activeStageId = null,
  onStageActivate,
  onToggleAbsent,
  subPartTags,
  onSubPartTagUpdate,
  subPartResetKey,
}: FormPanelProps) {
  const [selectedConcept, setSelectedConcept] = useState<ConceptSearchHit | null>(null);
  const [schemaTree, setSchemaTree] = useState<ConceptSchemaTree | null>(null);
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [selectedRefinement, setSelectedRefinement] = useState<TypeRefinementChild | null>(null);
  const [propertyValues, setPropertyValues] = useState<PropertyFormValues>({});

  // When the session rebuilds (ghost layer re-render), re-apply conceptSet so
  // the checklist stays coherent.
  useEffect(() => {
    if (!session) return;
    session.setConceptSet(selectedConcept !== null);
  }, [session, selectedConcept]);

  // Keep propertiesComplete in sync whenever the schema tree or values change.
  // Trivially true when schemaTree has no required schemas (§8 stageless concepts).
  useEffect(() => {
    if (!session) return;
    const isComplete = schemaTree
      ? computeIsComplete(schemaTree.schemas, propertyValues)
      : false;
    session.setPropertiesComplete(isComplete);
  }, [session, schemaTree, propertyValues]);

  const handleConceptSelect = useCallback(
    async (concept: ConceptSearchHit | null) => {
      setSelectedConcept(concept);
      setSelectedRefinement(null);  // refinement resets whenever concept changes
      onRefinementChange?.(null);

      if (!concept) {
        session?.setConceptSet(false);
        setSchemaTree(null);
        setSchemaError(null);
        setPropertyValues({});
        onConceptChange?.(null, null);
        return;
      }

      // Optimistically set conceptSet so the checklist updates immediately.
      session?.setConceptSet(true);

      setIsLoadingSchema(true);
      setSchemaError(null);
      try {
        const tree = await getConceptSchemas(concept.id);
        setSchemaTree(tree);
        // Carry over values for schemas shared with the previous concept;
        // discard values for schemas that no longer apply (Step 13).
        setPropertyValues(prev => carryOverValues(prev, tree.schemas));
        onConceptChange?.(concept, tree);
      } catch {
        setSchemaError('Could not load concept schema. Try again.');
        setSchemaTree(null);
        setPropertyValues({});
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

      {/* ── Section: Stages ──────────────────────────────────────────── */}
      {/* Rendered when the selected concept has CONTAINS edges (stage structure).
          Stageless concepts skip this section entirely (tagging-tool-design.md §8). */}
      {schemaTree && schemaTree.stages.length > 0 && (
        <section className={styles.section}>
          <Type variant="label-sm" as="h2" className={styles.sectionHeading}>
            Stages
          </Type>
          {assignments.some(
            a => !a.required && !a.absent && !a.confirmed && !a.orphaned,
          ) && (
            <Type variant="label-sm" as="p" className={styles.stagesHint}>
              Drag brackets to confirm bounds, or toggle to mark absent.
            </Type>
          )}
          <StageList
            assignments={assignments}
            activeStageId={activeStageId}
            onStageActivate={onStageActivate ?? (() => {})}
            onToggleAbsent={onToggleAbsent ?? (() => {})}
            subPartTags={subPartTags}
            onSubPartTagUpdate={onSubPartTagUpdate}
            subPartResetKey={subPartResetKey}
          />
        </section>
      )}

      {/* ── Section: Properties ──────────────────────────────────────── */}
      {/* Rendered when the selected concept has applicable property schemas.
          The form is entirely schema-driven — no concept-specific logic here.
          propertiesComplete is trivially true for concepts with no required
          schemas (§8 stageless concepts). */}
      {schemaTree && schemaTree.schemas.length > 0 && (
        <section className={styles.section}>
          <Type variant="label-sm" as="h2" className={styles.sectionHeading}>
            Properties
          </Type>
          <PropertyForm
            schemas={schemaTree.schemas}
            values={propertyValues}
            onChange={setPropertyValues}
          />
        </section>
      )}

      {/* ── Placeholder for Steps 16–18 ──────────────────────────────── */}
      {/* Harmony panel (Step 16), prose field (Step 17), and submission
          checklist (Step 18) are added in their respective steps. */}
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
