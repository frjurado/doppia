import React, { useEffect, useState } from 'react';
import type {
  ComposerResponse,
  CorpusResponse,
  MovementResponse,
  WorkResponse,
} from '../../types/browse';
import Surface from '../ui/Surface';
import Type from '../ui/Type';
import BrowseColumn from './BrowseColumn';
import BrowseItem from './BrowseItem';
import MovementCard from './MovementCard';
import styles from './BrowseAccordion.module.css';

type Level = 'composer' | 'corpus' | 'work' | 'movement';

interface BrowseAccordionProps {
  composers: ComposerResponse[];
  selectedComposerSlug: string | null;
  onSelectComposer: (slug: string) => void;
  composersLoading: boolean;

  corpora: CorpusResponse[];
  selectedCorpusSlug: string | null;
  onSelectCorpus: (slug: string) => void;
  corporaLoading: boolean;

  works: WorkResponse[];
  selectedWorkId: string | null;
  onSelectWork: (id: string) => void;
  worksLoading: boolean;

  movements: MovementResponse[];
  selectedMovementId: string | null;
  onSelectMovement: (id: string) => void;
  movementsLoading: boolean;
}

interface AccordionSectionProps {
  title: string;
  value: string;
  isOpen: boolean;
  onToggle: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}

function AccordionSection({
  title,
  value,
  isOpen,
  onToggle,
  disabled = false,
  children,
}: AccordionSectionProps) {
  return (
    <div className={styles.section}>
      <button
        type="button"
        className={styles.header}
        onClick={onToggle}
        disabled={disabled}
      >
        <Surface layer="container-low" className={styles.headerInner}>
          <Type variant="label-md" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
            {title}
          </Type>
          <Type variant="body-lg" as="span">
            {value}
          </Type>
        </Surface>
      </button>
      {isOpen && !disabled && (
        <Surface layer="container-low" className={styles.content}>
          {children}
        </Surface>
      )}
    </div>
  );
}

/**
 * Mobile accordion layout for the four-level corpus hierarchy.
 * Purpose-built — not a generic accordion. Each section auto-expands
 * when its parent level gains a selection.
 */
export default function BrowseAccordion({
  composers,
  selectedComposerSlug,
  onSelectComposer,
  composersLoading,
  corpora,
  selectedCorpusSlug,
  onSelectCorpus,
  corporaLoading,
  works,
  selectedWorkId,
  onSelectWork,
  worksLoading,
  movements,
  selectedMovementId,
  onSelectMovement,
  movementsLoading,
}: BrowseAccordionProps) {
  const [openSection, setOpenSection] = useState<Level>('composer');

  // Auto-advance to next section when a parent selection is made.
  useEffect(() => {
    if (selectedComposerSlug) setOpenSection('corpus');
  }, [selectedComposerSlug]);

  useEffect(() => {
    if (selectedCorpusSlug) setOpenSection('work');
  }, [selectedCorpusSlug]);

  useEffect(() => {
    if (selectedWorkId) setOpenSection('movement');
  }, [selectedWorkId]);

  const selectedComposer = composers.find((c) => c.slug === selectedComposerSlug);
  const selectedCorpus = corpora.find((c) => c.slug === selectedCorpusSlug);
  const selectedWork = works.find((w) => w.id === selectedWorkId);
  const selectedMovement = movements.find((m) => m.id === selectedMovementId);

  function toggle(level: Level) {
    setOpenSection((prev) => (prev === level ? 'composer' : level));
  }

  return (
    <div className={styles.accordion}>
      <AccordionSection
        title="Composer"
        value={selectedComposer?.name ?? 'Select a composer'}
        isOpen={openSection === 'composer'}
        onToggle={() => toggle('composer')}
      >
        <BrowseColumn
          items={composers}
          selectedId={selectedComposerSlug}
          onSelect={onSelectComposer}
          isLoading={composersLoading}
          getKey={(c) => c.slug}
          renderItem={(c, isSelected, onSelect) => (
            <BrowseItem key={c.slug} id={c.slug} isSelected={isSelected} onClick={onSelect}>
              <Type variant="body-lg" as="span">{c.name}</Type>
            </BrowseItem>
          )}
        />
      </AccordionSection>

      <AccordionSection
        title="Corpus"
        value={selectedCorpus?.title ?? 'Select a corpus'}
        isOpen={openSection === 'corpus'}
        onToggle={() => toggle('corpus')}
        disabled={!selectedComposerSlug}
      >
        <BrowseColumn
          items={corpora}
          selectedId={selectedCorpusSlug}
          onSelect={onSelectCorpus}
          isLoading={corporaLoading}
          getKey={(c) => c.slug}
          renderItem={(c, isSelected, onSelect) => (
            <BrowseItem key={c.slug} id={c.slug} isSelected={isSelected} onClick={onSelect}>
              <Type variant="body-lg" as="span">{c.title}</Type>
            </BrowseItem>
          )}
          emptyLabel="No corpora found"
        />
      </AccordionSection>

      <AccordionSection
        title="Work"
        value={selectedWork?.title ?? 'Select a work'}
        isOpen={openSection === 'work'}
        onToggle={() => toggle('work')}
        disabled={!selectedCorpusSlug}
      >
        <BrowseColumn
          items={works}
          selectedId={selectedWorkId}
          onSelect={onSelectWork}
          isLoading={worksLoading}
          getKey={(w) => w.id}
          renderItem={(w, isSelected, onSelect) => (
            <BrowseItem key={w.id} id={w.id} isSelected={isSelected} onClick={onSelect}>
              <Type variant="body-lg" as="span">{w.title}</Type>
              {w.catalogue_number && (
                <Type
                  variant="label-sm"
                  as="span"
                  style={{ color: 'var(--color-on-surface-variant)', display: 'block' }}
                >
                  {w.catalogue_number}
                </Type>
              )}
            </BrowseItem>
          )}
          emptyLabel="No works found"
        />
      </AccordionSection>

      <AccordionSection
        title="Movement"
        value={
          selectedMovement
            ? (selectedMovement.title ?? `Movement ${selectedMovement.movement_number}`)
            : 'Select a movement'
        }
        isOpen={openSection === 'movement'}
        onToggle={() => toggle('movement')}
        disabled={!selectedWorkId}
      >
        <BrowseColumn
          items={movements}
          selectedId={selectedMovementId}
          onSelect={onSelectMovement}
          isLoading={movementsLoading}
          getKey={(m) => m.id}
          renderItem={(m, isSelected, onSelect) => (
            <MovementCard key={m.id} movement={m} isSelected={isSelected} onClick={onSelect} />
          )}
          emptyLabel="No movements found"
        />
      </AccordionSection>
    </div>
  );
}
