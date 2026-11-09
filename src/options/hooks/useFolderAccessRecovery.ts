import { useEffect, useRef } from 'react';

// Opening the manager can inherit transient activation from the toolbar click.
// Wait for it to expire before attempting a persisted grant, so an unrelated
// click cannot cause a new permission prompt. Temporary grants keep Reconnect.
export function useFolderAccessRecovery(permission: PermissionState | null, refresh: () => Promise<unknown>) {
    const refreshRef = useRef(refresh);
    useEffect(() => { refreshRef.current = refresh; }, [refresh]);
    useEffect(() => {
        if (permission !== 'prompt') return;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const recover = () => {
            clearTimeout(timer);
            if (document.visibilityState !== 'visible') return;
            if (navigator.userActivation?.isActive) {
                timer = setTimeout(recover, 250);
                return;
            }
            void refreshRef.current().catch(console.error);
        };
        recover();
        window.addEventListener('focus', recover);
        document.addEventListener('visibilitychange', recover);
        return () => {
            clearTimeout(timer);
            window.removeEventListener('focus', recover);
            document.removeEventListener('visibilitychange', recover);
        };
    }, [permission]);
}
