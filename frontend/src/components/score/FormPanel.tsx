/**
 * Form panel — tagging-tool-design.md §7.
 *
 * The right-hand panel of the tagging interface. Hosts:
 *   §7.1 ConceptPicker  — search, domain facets, hierarchy-path display
 *   §7.2 TypeRefinement — radio group when children differ structurally
 *   §7.3 StageList      — stage cards with bounds display and absent toggle
 *   §7.4 PropertyForm   — dynamic property form driven by schema tree (Step 13)
 *   Step 16 HarmonyPanel — harmony event review and edit
 *   Step 17 Prose field   — free-text commentary (prose_annotation)
 *   (Step 18 adds Submission checklist.)
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

import { useCallback, useEffect, useRef, useState } from 'react';
import { getConceptSchemas } from '../../services/conceptApi';
import type {
  ConceptSchemaTree,
  ConceptSearchHit,
  TypeRefinementChild,
} from '../../services/conceptApi';
import type { AnnotationSession, SelectionRange } from './annotator';
import type { AnnotationFlags } from './annotator';
import type { StageAssignment, SubPartTag } from './stages';
import ConceptPicker from './ConceptPicker';
import TypeRefinement from './TypeRefinement';
import StageList from './StageList';
import PropertyForm from './PropertyForm';
import HarmonyPanel from './HarmonyPanel';
import SubmissionChecklist from './SubmissionChecklist';
import type { PropertyFormValues } from './PropertyForm';
import { carryOverValues, computeIsComplete } from './propertyFormHelpers';
import Type from '../ui/Type';
import styles from './FormPanel.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Form state that FormPanel passes to ScoreViewer via the onSaveDraft /
 * onSubmitFragment callbacks. ScoreViewer combines it with the selection,
 * stage, and prose data it owns to assemble the full fragment payload.
 */
export interface FormSubmitData {
  /** Neo4j Concept.id of the selected concept. */
  conceptId: string;
  /** Neo4j Concept.id of the selected Type Refinement, or null if none. */
  refinementId: string | null;
  /** Current property values keyed by PropertySchema.id. */
  propertyValues: PropertyFormValues;
}

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

  // ── Step 16: Harmony panel ──────────────────────────────────────────────

  /** UUID of the movement currently displayed. Needed to fetch harmony events. */
  movementId?: string | null;
  /** Committed selection range; used to slice harmony events by bar range. */
  selectionRange?: SelectionRange | null;

  // ── Step 17: Prose annotation ────────────────────────────────────────────

  /** Current prose annotation text; owned by ScoreViewer. */
  proseAnnotation?: string;
  /** Called on every keystroke in the prose textarea. */
  onProseChange?: (value: string) => void;

  // ── Step 18: Submission checklist ────────────────────────────────────────

  /**
   * Called when the annotator clicks Save Draft. Receives the FormPanel's
   * local concept/property state; ScoreViewer assembles the full payload.
   */
  onSaveDraft?: (data: FormSubmitData) => void;
  /**
   * Called when the annotator clicks Submit for Review. Receives the same
   * local state; ScoreViewer assembles, saves, and then submits.
   */
  onSubmitFragment?: (data: FormSubmitData) => void;
  /** True while a Save Draft request is in flight. */
  isSavingDraft?: boolean;
  /** True while a Submit request is in flight. */
  isSubmitting?: boolean;
  /** Error from the most recent save or submit attempt. */
  submitError?: string | null;
  /** UUID of the previously saved draft; null = unsaved. */
  draftId?: string | null;
  /**
   * Called when the user clicks the Delete fragment button. Triggers a full
   * reset of the session and all annotation state (G1.2).
   */
  onDeleteFragment?: () => void;
}

// ---------------------------------------------------------------------------
// Panel resize (G6.1)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'doppia.harmonyPanel.width';
const MIN_WIDTH = 280;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 320;

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_WIDTH;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n)) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function usePanelResize() {
  const [width, setWidth] = useState<number>(readStoredWidth);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startWidth: width };

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragState.current) return;
      const delta = dragState.current.startX - ev.clientX;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragState.current.startWidth + delta));
      setWidth(next);
    };

    const onMouseUp = (ev: MouseEvent) => {
      if (!dragState.current) return;
      const delta = dragState.current.startX - ev.clientX;
      const final = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragState.current.startWidth + delta));
      dragState.current = null;
      try { localStorage.setItem(STORAGE_KEY, String(final)); } catch { /* ignore */ }
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [width]);

  return { width, onMouseDown };
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
  movementId,
  selectionRange,
  proseAnnotation = '',
  onProseChange,
  onSaveDraft,
  onSubmitFragment,
  isSavingDraft = false,
  isSubmitting = false,
  submitError = null,
  draftId = null,
  onDeleteFragment,
}: FormPanelProps) {
  const { width: panelWidth, onMouseDown: onHandleMouseDown } = usePanelResize();
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
    <aside className={styles.panel} style={{ width: panelWidth }} aria-label="Annotation form">
      {/* ── Resize handle (G6.1) ─────────────────────────────────────── */}
      <div
        className={styles.resizeHandle}
        onMouseDown={onHandleMouseDown}
        aria-hidden="true"
      />
      {/* ── Fragment header: Delete control (G1.2) ───────────────────── */}
      {/* Once a fragment is committed, the only reset path is Delete —
          which clears selection, concept, stages, and properties together.
          tagging-tool-design.md §6. */}
      {flags.fragmentSet && (
        <div className={styles.fragmentHeader}>
          <Type variant="label-sm" as="span" className={styles.fragmentHeaderLabel}>
            Fragment
          </Type>
          <button
            type="button"
            className={styles.deleteButton}
            onClick={onDeleteFragment}
            aria-label="Delete fragment and start over"
          >
            <Type variant="label-sm" as="span">Delete</Type>
          </button>
        </div>
      )}

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

      {/* ── Section: Harmony ─────────────────────────────────────────── */}
      {/* Rendered when a selection is committed and a movement is loaded.
          Reads movement_analysis events sliced by the selection bar range;
          lets the annotator confirm, edit, insert, and delete events so the
          approval gate can pass (Step 16). */}
      {flags.fragmentSet && movementId && (
        <section className={styles.section}>
          <Type variant="label-sm" as="h2" className={styles.sectionHeading}>
            Harmony
          </Type>
          <HarmonyPanel
            movementId={movementId}
            selectionRange={selectionRange ?? null}
          />
        </section>
      )}

      {/* ── Section: Commentary ──────────────────────────────────────── */}
      {/* Free-text prose annotation (fragment.prose_annotation). Rendered
          once a selection is committed. Embeddings are generated in Phase 3;
          Phase 1 persists the raw text only (Step 17). */}
      {flags.fragmentSet && (
        <section className={styles.section}>
          <Type variant="label-sm" as="h2" className={styles.sectionHeading}>
            Commentary
          </Type>
          <label htmlFor="prose-annotation" className={styles.proseLabel}>
            <Type variant="label-sm" as="span" className={styles.proseDescription}>
              Expert commentary on this fragment. Stored verbatim; becomes the
              searchable annotation corpus in Phase 3.
            </Type>
          </label>
          <textarea
            id="prose-annotation"
            className={styles.proseTextarea}
            value={proseAnnotation}
            onChange={e => onProseChange?.(e.target.value)}
            placeholder="Add analytical commentary…"
            rows={5}
            aria-label="Prose annotation"
          />
        </section>
      )}

      {/* ── Step 18: Submission checklist ────────────────────────────── */}
      {/* Always visible. Shows the annotator which blocking items remain and
          provides Save Draft / Submit for Review actions. Replaces the
          "no selection" hint — the checklist itself signals missing items. */}
      <section className={styles.section}>
        <SubmissionChecklist
          flags={flags}
          typeRefinementRequired={typeRefinements.length > 0}
          typeRefinementSet={selectedRefinement !== null}
          isSavingDraft={isSavingDraft}
          isSubmitting={isSubmitting}
          submitError={submitError}
          draftId={draftId}
          onSaveDraft={() => {
            if (!selectedConcept) return;
            onSaveDraft?.({
              conceptId: selectedConcept.id,
              refinementId: selectedRefinement?.id ?? null,
              propertyValues,
            });
          }}
          onSubmit={() => {
            if (!selectedConcept) return;
            onSubmitFragment?.({
              conceptId: selectedConcept.id,
              refinementId: selectedRefinement?.id ?? null,
              propertyValues,
            });
          }}
        />
      </section>
    </aside>
  );
}
