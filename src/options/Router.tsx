import { Suspense } from 'react';
import { createHashRouter, RouterProvider, Navigate, useLocation } from 'react-router-dom';
import App from './App';

function LegacyRedirect() {
  const location = useLocation();
  const page = location.pathname.replace(/^\//, '') || 'scripts';
  return <Navigate to={'/options/' + page + location.search} replace />;
}
const router = createHashRouter([
  { path: '/options/*', element: <App /> },
  { path: '/*', element: <LegacyRedirect /> },
]);
export default function OptionsRouter() {
  return <Suspense fallback={null}><RouterProvider router={router} /></Suspense>;
}
