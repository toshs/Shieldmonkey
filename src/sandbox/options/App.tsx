import { Routes, Route, Navigate, useParams } from 'react-router-dom';
// Import only the languages we need - NO, we remove Monaco completely
import './App.css';

import { AppProvider } from './context/AppContext';
import { ModalProvider } from './context/ModalContext';

import Layout from './components/Layout';
import Scripts from './pages/Scripts';
import ScriptEditor from './pages/ScriptEditor';
import Settings from './pages/Settings';
import Help from './pages/Help';
import PermissionHelp from './pages/PermissionHelp';
import Install from './pages/Install';

function EditorRoute() {
  const { id } = useParams<{ id: string }>();
  return <ScriptEditor key={id || 'new'} />;
}

function App() {
  return (
    <AppProvider>
      <ModalProvider>
        <Routes>
          <Route path="install" element={<Install />} />
          <Route path="permission-help" element={
            <div style={{ flex: 1, display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', flexDirection: 'column' }}>
              <PermissionHelp />
            </div>
          } />

          <Route element={<Layout />}>
            <Route index element={<Navigate to="scripts" replace />} />
            <Route path="scripts" element={<Scripts />} />

            <Route path="settings" element={<Settings />} />
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
