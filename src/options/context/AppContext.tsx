import React, { useState, useEffect, type ReactNode } from 'react';
import { type Script, type Theme } from '../types';
import { AppContext } from './AppContextDefinition';
import { app } from '../../app/service';


export const AppProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [scripts, setScripts] = useState<Script[]>([]);
    const [folders, setFolders] = useState<string[]>([]);
    const [theme, setTheme] = useState<Theme>('dark');
    const [extensionEnabled, setExtensionEnabled] = useState(true);

    // Initial Load & Storage Sync
    useEffect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        app.call('GET_SETTINGS').then((data: any) => {
            const storedTheme = (data.theme as Theme) || 'dark';
            setTheme(storedTheme);
            if (data.extensionEnabled !== undefined) setExtensionEnabled(!!data.extensionEnabled);

            const storedScripts = data.scripts as Script[] | undefined;
            setFolders(Array.isArray(data.scriptFolders) ? data.scriptFolders : []);
            if (Array.isArray(storedScripts)) {
                const initializedScripts = storedScripts.map(s => ({
                    ...s,
                    lastSavedCode: s.code,
                    enabled: s.enabled !== false
                }));
                setScripts(initializedScripts);
            }
        });
    }, []);

    // Listen for storage changes
    useEffect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const handleStorageChange = (changes: { [key: string]: any }, areaName: string) => {
            if (areaName === 'local') {
                if (changes.scripts && Array.isArray(changes.scripts.newValue)) {
                    setScripts(() => {
                        const newScripts = changes.scripts.newValue as Script[];
                        return newScripts.map(s => {
                            return {
                                ...s,
                                enabled: s.enabled !== false,
                                lastSavedCode: s.code
                            };
                        });
                    });
                }
                if (changes.scriptFolders && Array.isArray(changes.scriptFolders.newValue)) {
                    setFolders(changes.scriptFolders.newValue as string[]);
                }
                if (changes.theme) {
                    setTheme(changes.theme.newValue as Theme);
                }
                if (changes.extensionEnabled) {
                    setExtensionEnabled(!!changes.extensionEnabled.newValue);
                }
            }
        };
        const removeListener = app.onStorageChanged(handleStorageChange);
        return () => { removeListener(); };
    }, []);

    // Apply Theme
    useEffect(() => {
        if (theme === 'system') {
            const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
            const handleChange = (e: MediaQueryListEvent) => {
                document.documentElement.setAttribute('data-theme', e.matches ? 'light' : 'dark');
            };
            document.documentElement.setAttribute('data-theme', mediaQuery.matches ? 'light' : 'dark');
            mediaQuery.addEventListener('change', handleChange);
            return () => mediaQuery.removeEventListener('change', handleChange);
        } else {
            document.documentElement.setAttribute('data-theme', theme);
        }
    }, [theme]);

    const updateTheme = (newTheme: Theme) => {
        setTheme(newTheme);
        app.call('UPDATE_THEME', newTheme);
    };

    const handleToggleExtension = (enabled: boolean) => {
        const before = extensionEnabled;
        setExtensionEnabled(enabled);
        void app.call('TOGGLE_GLOBAL', enabled).catch(error => {
            setExtensionEnabled(before);
            console.error('Could not change extension state:', error);
        });
    };

    const reloadScripts = async () => {
        const data = await app.call('GET_SETTINGS');
        setFolders(Array.isArray(data.scriptFolders) ? data.scriptFolders : []);
        if (Array.isArray(data.scripts)) {
            setScripts(data.scripts.map((s: Script) => ({ ...s, lastSavedCode: s.code, enabled: s.enabled !== false })));
        }
    };

    const saveScript = async (script: Script) => {
        await app.call('SAVE_SCRIPT', script);
    };

    const deleteScript = async (id: string) => {
        await app.call('DELETE_SCRIPT', { scriptId: id });
    };

    const toggleScript = async (script: Script, enabled: boolean) => {
        // Restore the visible state if the browser rejects registration.
        setScripts(prev => prev.map(s => s.id === script.id ? { ...s, enabled } : s));
        try {
            await app.call('TOGGLE_SCRIPT', { scriptId: script.id, enabled });
        } catch (error) {
            setScripts(prev => prev.map(s => s.id === script.id ? { ...s, enabled: script.enabled } : s));
            throw error;
        }
    };

    const updateLibrary = async (nextScripts: Script[], nextFolders: string[]) => {
        await app.call('UPDATE_LIBRARY', { scripts: nextScripts, folders: nextFolders });
        await reloadScripts();
    };

    return (
        <AppContext.Provider value={{
            scripts,
            folders,
            theme,
            extensionEnabled,
            setTheme: updateTheme,
            toggleExtension: handleToggleExtension,
            setScripts,
            reloadScripts,
            saveScript,
            deleteScript,
            toggleScript,
            updateLibrary
        }}>
            {children}
        </AppContext.Provider>
    );
};
