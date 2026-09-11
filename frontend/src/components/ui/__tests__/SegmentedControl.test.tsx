/**
 * Segmented control, its single-option sibling, and the icon button
 * (design-debt register F12, the score-surface half).
 *
 * The visuals are colour, which JSDOM cannot judge. These cover the contract
 * the call sites depend on — and, in two cases, the accessibility properties
 * the bespoke implementations had got right and a shared component must not
 * lose.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SegmentedControl, { ToggleButton } from '../SegmentedControl';
import IconButton from '../IconButton';

const SIZES = [
  { value: 'sm', label: 'Small' },
  { value: 'md', label: 'Medium' },
  { value: 'lg', label: 'Large' },
] as const;

describe('SegmentedControl', () => {
  it('marks only the selected option as pressed', () => {
    render(
      <SegmentedControl ariaLabel="Staff size" options={SIZES} value="md" onChange={vi.fn()} />
    );
    expect(screen.getByRole('button', { name: 'Medium' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Small' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Large' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('names the group, so a row of two-letter buttons is not anonymous', () => {
    render(
      <SegmentedControl ariaLabel="Staff size" options={SIZES} value="md" onChange={vi.fn()} />
    );
    expect(screen.getByRole('group', { name: 'Staff size' })).toBeInTheDocument();
  });

  it('reports the value of the option clicked', async () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl ariaLabel="Staff size" options={SIZES} value="md" onChange={onChange} />
    );
    await userEvent.click(screen.getByRole('button', { name: 'Large' }));
    expect(onChange).toHaveBeenCalledWith('lg');
  });

  it('names an icon segment from ariaLabel', async () => {
    // The grid-resolution control's segments are glyphs; without this they
    // reach a screen reader as nothing at all.
    const onChange = vi.fn();
    render(
      <SegmentedControl
        ariaLabel="Selection grid"
        value="measure"
        onChange={onChange}
        options={[
          { value: 'measure', label: <svg />, ariaLabel: 'By measure' },
          { value: 'beat', label: <svg />, ariaLabel: 'By beat' },
        ]}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: 'By beat' }));
    expect(onChange).toHaveBeenCalledWith('beat');
  });

  it('does not submit a surrounding form', () => {
    // Every one of these lived inside toolbars, but the default type on a bare
    // <button> is submit; the shared component pins it.
    render(
      <SegmentedControl ariaLabel="Staff size" options={SIZES} value="md" onChange={vi.fn()} />
    );
    expect(screen.getByRole('button', { name: 'Small' })).toHaveAttribute('type', 'button');
  });
});

describe('ToggleButton', () => {
  it('exposes its pressed state', () => {
    const { rerender } = render(<ToggleButton pressed={false}>Tag</ToggleButton>);
    expect(screen.getByRole('button', { name: 'Tag' })).toHaveAttribute('aria-pressed', 'false');
    rerender(<ToggleButton pressed>Done</ToggleButton>);
    expect(screen.getByRole('button', { name: 'Done' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('fires onClick', async () => {
    const onClick = vi.fn();
    render(
      <ToggleButton pressed={false} onClick={onClick}>
        Harmony
      </ToggleButton>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Harmony' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('IconButton', () => {
  it('takes its accessible name from ariaLabel', () => {
    // A glyph names nothing, which is why the prop is required rather than
    // optional.
    render(<IconButton ariaLabel="Play">▶</IconButton>);
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
  });

  it('does not fire onClick while disabled', async () => {
    const onClick = vi.fn();
    render(
      <IconButton ariaLabel="Rewind" disabled onClick={onClick}>
        ⏮
      </IconButton>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Rewind' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('keeps a caller class alongside its own', () => {
    render(
      <IconButton ariaLabel="Close" className="local-layout">
        ×
      </IconButton>
    );
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('local-layout');
  });

  it('defaults to type="button"', () => {
    render(<IconButton ariaLabel="Stop">■</IconButton>);
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveAttribute('type', 'button');
  });
});
