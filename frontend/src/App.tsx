import { BrowserRouter, Route, Routes } from 'react-router-dom';
import CorpusBrowser from './routes/CorpusBrowser';
import ScoreViewerStub from './routes/ScoreViewerStub';

/**
 * Root application component.
 *
 * Sets up the React Router BrowserRouter and top-level route tree.
 * Routes are added here as components are built in each Phase 1 component task.
 *
 * Design system: before writing any UI, read docs/mockups/opus_urtext/DESIGN.md.
 * Key constraints: Henle Blue #3f5f77, Urtext Cream #fbf9f0, 0px border-radius everywhere.
 */
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<CorpusBrowser />} />
        <Route path="/tag/:movementId" element={<ScoreViewerStub />} />
        {/* Component 8: <Route path="/fragments" element={<FragmentBrowser />} /> */}
      </Routes>
    </BrowserRouter>
  );
}
