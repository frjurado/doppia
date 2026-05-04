import { useParams } from 'react-router-dom';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';

/**
 * Placeholder page at /tag/:movementId.
 * Replaced entirely by Component 3's score viewer — no code carries forward.
 */
export default function ScoreViewerStub() {
  const { movementId } = useParams<{ movementId: string }>();
  usePageTitle('Score Viewer — Doppia');

  return (
    <Surface
      layer="base"
      style={{
        height: '100%',
        padding: 'var(--spacing-8)',
      }}
    >
      <Type variant="headline" as="h1">Score Viewer</Type>
      <Type variant="body-lg" style={{ marginTop: 'var(--spacing-4)' }}>
        {/* dev-only: replaced by Component 3 */}
        Movement ID: {movementId}
      </Type>
      <Type
        variant="body-sm"
        style={{ marginTop: 'var(--spacing-3)', color: 'var(--color-on-surface-variant)' }}
      >
        Score viewer coming soon (Component 3).
      </Type>
    </Surface>
  );
}
