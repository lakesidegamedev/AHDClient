/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BootScreen } from './BootScreen.js';

afterEach(cleanup);

describe('BootScreen', () => {
  const base = {
    title: 'Starting',
    lines: [],
    onCancel: () => {},
    showDebug: false,
  };

  it('never moves reported setup progress backwards', () => {
    const { rerender } = render(
      <BootScreen
        {...base}
        progress={{ label: 'A', detail: 'A', progress: 64, stalled: false }}
      />,
    );
    rerender(
      <BootScreen
        {...base}
        progress={{ label: 'B', detail: 'B', progress: 31, stalled: false }}
      />,
    );

    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(
      '64',
    );
    expect(
      screen
        .getByRole('progressbar')
        .querySelector('span')
        ?.getAttribute('style'),
    ).toContain('64%');
  });

  it('clamps malformed progress to the track', () => {
    render(
      <BootScreen
        {...base}
        progress={{ label: 'A', detail: 'A', progress: 140, stalled: false }}
      />,
    );
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe(
      '100',
    );
  });

  it('shows an indeterminate bar, not an invented percent, before real progress', () => {
    render(<BootScreen {...base} lines={['[ahd] one', '[ahd] two']} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(bar.className).toContain('indeterminate');
    expect(screen.getByText(/Time so far 0:00/)).toBeTruthy();
  });

  it('names the first-run database download', () => {
    render(<BootScreen {...base} lines={['[ahd] MongoDB download: 30%']} />);
    expect(screen.getByText('Downloading the database')).toBeTruthy();
    expect(screen.getByText(/First time only. 30% done./)).toBeTruthy();
  });

  it('keeps the player on a retry screen after a failure', async () => {
    const onRetry = vi.fn();
    render(
      <BootScreen
        {...base}
        failure={{ message: 'The game exited before it was ready:\nstack line one' }}
        onRetry={onRetry}
        onBack={() => {}}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('The game exited before it was ready:');
    expect(screen.getByText('Details')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});
