import type { MovementResponse } from '../../types/browse';
import Type from '../ui/Type';
import BrowseItem from './BrowseItem';
import IncipitImage from './IncipitImage';
import styles from './MovementCard.module.css';

interface MovementCardProps {
  movement: MovementResponse;
  isSelected: boolean;
  onClick: (id: string) => void;
}

/**
 * A BrowseItem variant for movements. Renders title, key/meter metadata,
 * and the incipit image below the text labels.
 */
export default function MovementCard({ movement, isSelected, onClick }: MovementCardProps) {
  const subtitle = [movement.key_signature, movement.meter].filter(Boolean).join(' · ');

  return (
    <BrowseItem id={movement.id} isSelected={isSelected} onClick={onClick}>
      <div className={styles.meta}>
        <Type variant="body-lg" as="span">
          {movement.title ?? `Movement ${movement.movement_number}`}
        </Type>
        {subtitle && (
          <Type
            variant="label-sm"
            as="span"
            style={{ color: 'var(--color-on-surface-variant)', display: 'block' }}
          >
            {subtitle}
          </Type>
        )}
      </div>
      <IncipitImage url={movement.incipit_url} ready={movement.incipit_ready} />
    </BrowseItem>
  );
}
