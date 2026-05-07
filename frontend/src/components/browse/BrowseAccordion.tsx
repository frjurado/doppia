import React, { useEffect, useState } from 'react';
import type { UseBrowseSelectionReturn } from '../../hooks/useBrowseSelection';
import Surface from '../ui/Surface';
import Type from '../ui/Type';
import BrowseColumn from './BrowseColumn';
import BrowseItem from './BrowseItem';
import MovementCard from './MovementCard';
import styles from './BrowseAccordion.module.css';

type Level = 'composer' | 'corpus' | 'work' | 'movement';

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
export default function BrowseAccordion({ selection }: { selection: UseBrowseSelectionReturn }) {
  const {
    composers,
    composerSlug,
    composersLoading,
    corpora,
    corpusSlug,
    corporaLoading,
    works,
    workId,
    worksLoading,
    movements,
    movementId,
    movementsLoading,
    select,
  } = selection;

  const [openSection, setOpenSection] = useState<Level>('composer');

  // Auto-advance to next section when a parent selection is made.
  useEffect(() => {
    if (workId) setOpenSection('movement');
    else if (corpusSlug) setOpenSection('work');
    else if (composerSlug) setOpenSection('corpus');
  }, [composerSlug, corpusSlug, workId]);

  const selectedComposer = composers.find((c) => c.slug === composerSlug);
  const selectedCorpus = corpora.find((c) => c.slug === corpusSlug);
  const selectedWork = works.find((w) => w.id === workId);
  const selectedMovement = movements.find((m) => m.id === movementId);

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
          selectedId={composerSlug}
          onSelect={(slug) => select('composer', slug)}
          isLoading={composersLoading}
          getKey={(c) => c.slug}
          renderItem={(c, isSelected, onSelect) => (
            <BrowseItem id={c.slug} isSelected={isSelected} onClick={onSelect}>
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
        disabled={!composerSlug}
      >
        <BrowseColumn
          items={corpora}
          selectedId={corpusSlug}
          onSelect={(slug) => select('corpus', slug)}
          isLoading={corporaLoading}
          getKey={(c) => c.slug}
          renderItem={(c, isSelected, onSelect) => (
            <BrowseItem id={c.slug} isSelected={isSelected} onClick={onSelect}>
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
        disabled={!corpusSlug}
      >
        <BrowseColumn
          items={works}
          selectedId={workId}
          onSelect={(id) => select('work', id)}
          isLoading={worksLoading}
          getKey={(w) => w.id}
          renderItem={(w, isSelected, onSelect) => (
            <BrowseItem id={w.id} isSelected={isSelected} onClick={onSelect}>
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
        disabled={!workId}
      >
        <BrowseColumn
          items={movements}
          selectedId={movementId}
          onSelect={(id) => select('movement', id)}
          isLoading={movementsLoading}
          getKey={(m) => m.id}
          renderItem={(m, isSelected, onSelect) => (
            <MovementCard movement={m} isSelected={isSelected} onClick={onSelect} />
          )}
          emptyLabel="No movements found"
        />
      </AccordionSection>
    </div>
  );
}
