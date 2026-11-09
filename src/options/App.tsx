import { lazy } from 'react';
import { Routes, Route, Navigate, useParams } from 'react-router-dom';
// Import only the languages we need - NO, we remove Monaco completely
import './App.css';

import { AppProvider } from './context/AppContext';
import { ModalProvider } from './context/ModalContext';

import Layout from './components/Layout';
import Scripts from './pages/Scripts';
const ScriptEditor = lazy(() => import('./pages/ScriptEditor'));
const Settings = lazy(() => import('./pages/Settings'));
const Help = lazy(() => import('./pages/Help'));
const PermissionHelp = lazy(() => import('./pages/PermissionHelp'));
import ManualImportNotice from './pages/ManualImportNotice';
const History = lazy(() => import('./pages/History'));

function EditorRoute() {
  const { id } = useParams<{ id: string }>();
  return <ScriptEditor key={id || 'new'} />;
}

function App() {
  return (
    <AppProvider>
      <ModalProvider>
        <Routes>
          <Route path="install" element={<ManualImportNotice />} />
          <Route path="permission-help" element={
            <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', flexDirection: 'column' }}>
              <PermissionHelp />
            </div>
          } />

          <Route element={<Layout />}>
            <Route index element={<Navigate to="scripts" replace />} />
            <Route path="scripts" element={<Scripts />} />

            <Route path="settings" element={<Settings />} />
            <Route path="history" element={<History />} />
            <Route path="help" element={<Help />} />
          </Route>
          <Route path="scripts/:id" element={<EditorRoute />} />
          <Route path="new" element={<EditorRoute />} />
        </Routes>
      </ModalProvider>
    </AppProvider>
  );
}

export default App;
