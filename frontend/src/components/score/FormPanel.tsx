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
import { useTranslation } from 'react-i18next';
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
import InfoHint from '../ui/InfoHint';
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
    schemaTree: ConceptSchemaTree | null
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
  /**
   * True while a stage split-handle drag is in progress — freezes the stage
   * list's display order so cards don't jump mid-gesture (Part 8 item 4);
   * the list resorts by position once on release.
   */
  stageDragActive?: boolean;

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
  /**
   * Called after any successful harmony mutation so the in-score overlay
   * (Step 16 / G6.3) can refresh its cached event list.
   */
  onHarmonyUpdated?: () => void;
  /**
   * Event key to scroll/focus in HarmonyPanel — set by ScoreViewer when the
   * annotator clicks an in-score chord label (click-to-focus, Step 16).
   */
  harmonyFocusKey?: string | null;

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
  /**
   * Edit-prefill data for the fragment edit flow (Component 7 Step 12).
   * When set, FormPanel initialises with this concept and property values on
   * mount instead of starting blank. Consumed once via the prefillConsumedRef;
   * the fragmentResetKey on the parent gates remounting so this fires once
   * per edit session.
   */
  editPrefill?: {
    concept: ConceptSearchHit;
    propertyValues: PropertyFormValues;
  } | null;

  // ── Component 10 Step 16: edit-session lifecycle ──────────────────────────

  /**
   * Status of the stored fragment being edited, or null when this is a fresh
   * create. Drives the status-aware submission controls: draft/rejected keep
   * Save draft + Submit for review; submitted/approved show a single Save
   * changes (a PATCH — POST /submit rejects non-drafts).
   */
  editStatus?: 'draft' | 'submitted' | 'approved' | 'rejected' | null;
  /** Sub-part count of the fragment being edited; named in the delete confirm. */
  editSubPartCount?: number;
  /** Discard the edit and return to viewing the stored fragment (no DB write). */
  onCancelEdit?: () => void;
  /** Real DB delete of the fragment being edited; called only after confirmation. */
  onDeleteEditingFragment?: () => Promise<void>;
  /** Save an analytic edit of a submitted/approved fragment via PATCH. */
  onSaveChanges?: (data: FormSubmitData) => void;
  /** True while a Save changes request is in flight. */
  isSavingChanges?: boolean;
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

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
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
        const final = Math.min(
          MAX_WIDTH,
          Math.max(MIN_WIDTH, dragState.current.startWidth + delta)
        );
        dragState.current = null;
        try {
          localStorage.setItem(STORAGE_KEY, String(final));
        } catch {
          /* ignore */
        }
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('mouseup', onMouseUp);
      };

      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    },
    [width]
  );

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
  stageDragActive = false,
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
  editPrefill = null,
  editStatus = null,
  editSubPartCount = 0,
  onCancelEdit,
  onDeleteEditingFragment,
  onSaveChanges,
  isSavingChanges = false,
  onHarmonyUpdated,
  harmonyFocusKey,
}: FormPanelProps) {
  const { t } = useTranslation(['score', 'common']);
  const { width: panelWidth, onMouseDown: onHandleMouseDown } = usePanelResize();
  const [selectedConcept, setSelectedConcept] = useState<ConceptSearchHit | null>(null);
  const [schemaTree, setSchemaTree] = useState<ConceptSchemaTree | null>(null);
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [selectedRefinement, setSelectedRefinement] = useState<TypeRefinementChild | null>(null);
  const [propertyValues, setPropertyValues] = useState<PropertyFormValues>({});

  // ── Edit-session lifecycle (Step 16) ──────────────────────────────────────
  // editMode = editing a stored fragment (vs a fresh create). reviewedEdit =
  // that fragment is already submitted/approved, so the save is a PATCH-only
  // revision (Submit for review is not applicable). deleteConfirming gates the
  // inline delete confirmation; isDeleting covers the request in flight.
  const editMode = editStatus !== null;
  const reviewedEdit = editStatus === 'submitted' || editStatus === 'approved';
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleConfirmDelete = useCallback(async () => {
    if (!onDeleteEditingFragment) return;
    setIsDeleting(true);
    try {
      await onDeleteEditingFragment();
    } finally {
      // The parent unmounts/remounts this panel on success; guard anyway.
      setIsDeleting(false);
      setDeleteConfirming(false);
    }
  }, [onDeleteEditingFragment]);

  // ── Edit prefill (Component 7 Step 12) ────────────────────────────────────
  // When this FormPanel is remounted with an editPrefill (fragment edit flow),
  // consume it once on mount: store the property values in a ref so the async
  // schema fetch inside handleConceptSelect can apply them, then call
  // handleConceptSelect to load the concept and schema tree.
  const prefillConsumedRef = useRef(false);
  const prefillPropertyValuesRef = useRef<PropertyFormValues | null>(null);

  // Consume editPrefill once on mount.  fragmentResetKey on the parent gates
  // remounting so this fires at most once per edit session.
  useEffect(() => {
    if (!editPrefill || prefillConsumedRef.current) return;
    prefillConsumedRef.current = true;
    prefillPropertyValuesRef.current = editPrefill.propertyValues;
    handleConceptSelect(editPrefill.concept);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally mount-only; editPrefill is stable at mount time

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
    const isComplete = schemaTree ? computeIsComplete(schemaTree.schemas, propertyValues) : false;
    session.setPropertiesComplete(isComplete);
  }, [session, schemaTree, propertyValues]);

  const handleConceptSelect = useCallback(
    async (concept: ConceptSearchHit | null) => {
      setSelectedConcept(concept);
      setSelectedRefinement(null); // refinement resets whenever concept changes
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
        // If a prefill was stored (edit flow), use those values directly.
        // Otherwise carry over values for schemas shared with the previous concept.
        const prefillVals = prefillPropertyValuesRef.current;
        if (prefillVals !== null) {
          prefillPropertyValuesRef.current = null; // consumed
          setPropertyValues(prefillVals);
        } else {
          setPropertyValues((prev) => carryOverValues(prev, tree.schemas));
        }
        onConceptChange?.(concept, tree);
      } catch {
        setSchemaError(t('score:formPanel.conceptSchemaError'));
        setSchemaTree(null);
        setPropertyValues({});
        onConceptChange?.(concept, null);
      } finally {
        setIsLoadingSchema(false);
      }
    },
    [session, onConceptChange, onRefinementChange, t]
  );

  const handleRefinementChange = useCallback(
    (option: TypeRefinementChild | null) => {
      setSelectedRefinement(option);
      onRefinementChange?.(option);
    },
    [onRefinementChange]
  );

  const typeRefinements = schemaTree?.type_refinement.children ?? [];

  return (
    <aside
      className={styles.panel}
      style={{ width: panelWidth }}
      aria-label={t('score:formPanel.annotationFormAria')}
    >
      {/* ── Resize handle (G6.1) ─────────────────────────────────────── */}
      <div className={styles.resizeHandle} onMouseDown={onHandleMouseDown} aria-hidden="true" />
      {/* ── Fragment header: reset / lifecycle controls ──────────────── */}
      {/* Create (G1.2): a single Delete clears selection, concept, stages, and
          properties together. Edit (Step 16): Cancel discards the edit and
          returns to viewing the stored fragment, while Delete removes it from
          the database (real delete, behind an inline confirmation). */}
      {flags.fragmentSet && (
        <div className={styles.fragmentHeader}>
          <Type variant="label-sm" as="span" className={styles.fragmentHeaderLabel}>
            {t('score:formPanel.fragmentLabel')}
          </Type>
          {editMode ? (
            <div className={styles.fragmentHeaderActions}>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={onCancelEdit}
                disabled={isDeleting}
              >
                <Type variant="label-sm" as="span">
                  {t('score:formPanel.cancelEdit')}
                </Type>
              </button>
              <button
                type="button"
                className={styles.deleteButton}
                onClick={() => setDeleteConfirming(true)}
                disabled={isDeleting}
                aria-label={t('score:formPanel.deleteAria')}
              >
                <Type variant="label-sm" as="span">
                  {t('common:delete')}
                </Type>
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={styles.deleteButton}
              onClick={onDeleteFragment}
              aria-label={t('score:formPanel.deleteAria')}
            >
              <Type variant="label-sm" as="span">
                {t('common:delete')}
              </Type>
            </button>
          )}
        </div>
      )}

      {/* ── Inline delete confirmation (edit mode) ───────────────────── */}
      {editMode && deleteConfirming && (
        <div className={styles.deleteConfirm} role="alertdialog" aria-live="assertive">
          <Type variant="body-sm" as="p" className={styles.deleteConfirmText}>
            {editSubPartCount > 0
              ? t('score:detailPanel.deleteConfirmWithSubparts', { count: editSubPartCount })
              : t('score:detailPanel.deleteConfirm')}
          </Type>
          <div className={styles.deleteConfirmActions}>
            <button
              type="button"
              className={styles.confirmDeleteButton}
              onClick={handleConfirmDelete}
              disabled={isDeleting}
              aria-busy={isDeleting}
            >
              <Type variant="label-sm" as="span">
                {isDeleting
                  ? t('score:detailPanel.deleting')
                  : t('score:detailPanel.confirmDelete')}
              </Type>
            </button>
            <button
              type="button"
              className={styles.cancelButton}
              onClick={() => setDeleteConfirming(false)}
              disabled={isDeleting}
            >
              <Type variant="label-sm" as="span">
                {t('common:cancel')}
              </Type>
            </button>
          </div>
        </div>
      )}

      {/* ── Section: Concept ─────────────────────────────────────────── */}
      <section className={styles.section}>
        <Type variant="label-sm" as="h2" className={styles.sectionHeading}>
          {t('score:formPanel.sectionConcept')}
        </Type>
        <ConceptPicker
          selectedConceptId={selectedConcept?.id ?? null}
          selectedConcept={selectedConcept}
          onSelect={handleConceptSelect}
        />
        {isLoadingSchema && (
          <Type variant="label-sm" as="p" className={styles.schemaStatus}>
            {t('score:formPanel.loadingSchema')}
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
          {/* The interaction explanation lives behind the (i) — hover/focus —
              instead of a permanent paragraph (Part 8 item 4). */}
          <div className={styles.sectionHeadingRow}>
            <Type variant="label-sm" as="h2" className={styles.sectionHeading}>
              {t('score:formPanel.sectionStages')}
            </Type>
            <InfoHint
              text={t('score:formPanel.stagesHint')}
              ariaLabel={t('score:formPanel.stagesInfoAria')}
            />
          </div>
          <StageList
            assignments={assignments}
            activeStageId={activeStageId}
            onStageActivate={onStageActivate ?? (() => {})}
            onToggleAbsent={onToggleAbsent ?? (() => {})}
            subPartTags={subPartTags}
            onSubPartTagUpdate={onSubPartTagUpdate}
            subPartResetKey={subPartResetKey}
            freezeOrder={stageDragActive}
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
            {t('score:formPanel.sectionProperties')}
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
            {t('score:formPanel.sectionHarmony')}
          </Type>
          <HarmonyPanel
            movementId={movementId}
            selectionRange={selectionRange ?? null}
            onHarmonyUpdated={onHarmonyUpdated}
            focusedEventKey={harmonyFocusKey}
          />
        </section>
      )}

      {/* ── Section: Commentary ──────────────────────────────────────── */}
      {/* Free-text prose annotation (fragment.prose_annotation). Rendered
          once a selection is committed. Embeddings are generated in Phase 3;
          Phase 1 persists the raw text only (Step 17). */}
      {flags.fragmentSet && (
        <section className={styles.section}>
          {/* The "what is this field for" description lives behind the (i)
              instead of a permanent paragraph (Part 8 item 4). */}
          <div className={styles.sectionHeadingRow}>
            <Type variant="label-sm" as="h2" className={styles.sectionHeading}>
              {t('score:formPanel.sectionCommentary')}
            </Type>
            <InfoHint
              text={t('score:formPanel.commentaryDescription')}
              ariaLabel={t('score:formPanel.commentaryInfoAria')}
            />
          </div>
          <textarea
            id="prose-annotation"
            className={styles.proseTextarea}
            value={proseAnnotation}
            onChange={(e) => onProseChange?.(e.target.value)}
            placeholder={t('score:formPanel.commentaryPlaceholder')}
            rows={5}
            aria-label={t('score:formPanel.proseAria')}
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
          conceptHasStages={schemaTree !== null && schemaTree.stages.length > 0}
          isSavingDraft={isSavingDraft}
          isSubmitting={isSubmitting}
          submitError={submitError}
          draftId={draftId}
          reviewedEdit={reviewedEdit}
          isSavingChanges={isSavingChanges}
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
          onSaveChanges={() => {
            if (!selectedConcept) return;
            onSaveChanges?.({
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
