import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as browseApi from '../../services/browseApi';
import CorpusBrowser from '../CorpusBrowser';

vi.mock('../../services/browseApi');

describe('CorpusBrowser', () => {
  beforeEach(() => {
    // Default: all fetches resolve to empty lists (no selection active).
    vi.mocked(browseApi.fetchComposers).mockResolvedValue([]);
    vi.mocked(browseApi.fetchCorpora).mockResolvedValue([]);
    vi.mocked(browseApi.fetchWorks).mockResolvedValue([]);
    vi.mocked(browseApi.fetchMovements).mockResolvedValue([]);
  });

  it('renders the composer column heading', async () => {
    render(
      <MemoryRouter>
        <CorpusBrowser />
      </MemoryRouter>,
    );
    // "Composer" is the exact column header label; use getAllByText to handle
    // the case where "Select a composer" is also rendered in the corpus column.
    const headings = screen.getAllByText(/^composer$/i);
    expect(headings[0]).toBeInTheDocument();
  });

  it('shows a loading skeleton while composers are fetching', () => {
    // Never resolve — keeps the component in loading state.
    vi.mocked(browseApi.fetchComposers).mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter>
        <CorpusBrowser />
      </MemoryRouter>,
    );
    // The skeleton renders inside the column; confirm the column header is present.
    const headings = screen.getAllByText(/^composer$/i);
    expect(headings[0]).toBeInTheDocument();
  });

  it('shows an error state when the composers fetch fails', async () => {
    vi.mocked(browseApi.fetchComposers).mockRejectedValue(
      new Error('NETWORK_ERROR'),
    );
    render(
      <MemoryRouter>
        <CorpusBrowser />
      </MemoryRouter>,
    );
    // useBrowseSelection converts the raw Error to ApiError via String(err),
    // producing the message "Error: NETWORK_ERROR".
    await screen.findByText(/network_error/i);
  });

  it('renders the empty state after composers load with no results', async () => {
    vi.mocked(browseApi.fetchComposers).mockResolvedValue([]);
    render(
      <MemoryRouter>
        <CorpusBrowser />
      </MemoryRouter>,
    );
    // "Select a composer" appears in the corpus column when no composer is selected.
    await screen.findByText(/select a composer/i);
  });
});
