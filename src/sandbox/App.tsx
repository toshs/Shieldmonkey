import { lazy, Suspense, useEffect } from 'react';
import { createHashRouter, RouterProvider, Routes, Route, useLocation, Navigate, useNavigate } from 'react-router-dom';
import PopupApp from './popup/App';

const OptionsApp = lazy(() => import('./options/App'));

// Redirect logic for legacy paths (e.g. #/settings -> #/options/settings)
function RedirectToOptions() {
    const location = useLocation();
    const path = location.pathname.startsWith('/') ? location.pathname.slice(1) : location.pathname;
    return <Navigate to={`/options/${path}`} replace />;
}

// Removed HashSync as we simplify the routing approach to avoid the location API limits

function HashSync() {
    const { pathname, search, hash } = useLocation();
    const navigate = useNavigate();

    useEffect(() => {
        const fullPath = '#' + pathname + search + hash;
        window.parent.postMessage({ type: 'URL_CHANGED', hash: fullPath }, '*');
    }, [pathname, search, hash]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            if (event.data && event.data.type === 'NAVIGATE' && event.data.path) {
                const targetHash = event.data.path;
                const targetPath = targetHash.startsWith('#') ? targetHash.slice(1) : targetHash;

                if (pathname + search + hash !== targetPath) {
                    // Use replace to prevent blowing up the history stack
                    navigate(targetPath, { replace: true });
                }
            }
        };
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [navigate, pathname, search, hash]);

    return null;
}

function SandboxRoutes() {
    return (
        <>
            <Routes>
                <Route path="/popup/*" element={<PopupApp />} />
                <Route path="/options/*" element={<Suspense fallback={null}><OptionsApp /></Suspense>} />
                <Route path="*" element={<RedirectToOptions />} />
            </Routes>
            <HashSync />
        </>
    );
}

const router = createHashRouter([{ path: '/*', element: <SandboxRoutes /> }]);

function SandboxApp() {
    return <RouterProvider router={router} />;
}

export default SandboxApp;
