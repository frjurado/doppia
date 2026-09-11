/**
 * Shared button library (F12, Component 12 Step 14).
 *
 * The variants themselves are colour, which a JSDOM test cannot judge — these
 * cover the contract that callers depend on and that the migration off
 * eighteen bespoke stylesheets could silently break.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Button from '../Button';

describe('Button', () => {
  it('defaults to type="button", not the HTML default of submit', () => {
    // A bare <button> inside a form submits it. Every migrated call site that
    // dropped an explicit type="button" relies on this default.
    render(<Button>Delete</Button>);
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute('type', 'button');
  });

  it('lets a form CTA opt into type="submit"', () => {
    render(<Button type="submit">Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('type', 'submit');
  });

  it('keeps the caller className alongside the variant classes', () => {
    // Call sites that kept a layout-only class (Profile's align-self, the
    // corpus CTA's flex-shrink) would lose their positioning otherwise.
    render(<Button className="local-layout">Export</Button>);
    expect(screen.getByRole('button', { name: 'Export' })).toHaveClass('local-layout');
  });

  it('forwards arbitrary button attributes', () => {
    render(
      <Button aria-label="Delete fragment" aria-busy>
        Delete
      </Button>
    );
    const button = screen.getByRole('button', { name: 'Delete fragment' });
    expect(button).toHaveAttribute('aria-busy', 'true');
  });

  it('does not fire onClick while disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Submit
      </Button>
    );
    await userEvent.click(screen.getByRole('button', { name: 'Submit' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('applies a distinct class per variant', () => {
    // The destructive pair is the one that must never collapse into one class:
    // the trigger and the confirmation are deliberately different treatments.
    const { rerender } = render(<Button variant="destructive">Delete</Button>);
    const trigger = screen.getByRole('button').className;
    rerender(<Button variant="destructiveConfirm">Delete</Button>);
    expect(screen.getByRole('button').className).not.toBe(trigger);
  });
});
