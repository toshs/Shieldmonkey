/**
 * Browser Polyfill / Helper
 * Provides a unified interface for browser APIs, handling 'chrome' vs 'browser' namespaces.
 */

// Declare global types to avoid 'any'
declare global {
    interface Window {
        browser: typeof chrome;
    }
    // Note: 'browser' namespace usually mirrors 'chrome' structure in WebExtensions
}

// Access the browser API via globalThis, casting to unknown then to a compatible type
const globalScope = globalThis as unknown as { browser?: typeof chrome, chrome?: typeof chrome };
export const browserAPI = globalScope.browser || globalScope.chrome || chrome;

export const isFirefox = (): boolean => {
    return !!globalScope.browser && !!globalScope.browser.runtime;
};

export const isMobile = (): boolean => {
    return /Android|iPhone|iPad/i.test(navigator.userAgent);
};

export const isFileSystemSupported = (): boolean => {
    return typeof window.showDirectoryPicker === 'function';
};

/**
 * Request permissions using the appropriate API.
 * Firefox uses browser.permissions.request (Promise)
 * Chrome uses chrome.permissions.request (Callback in older versions, Promise in MV3)
 */
export const requestPermission = async (permissions: string[]): Promise<boolean> => {
    if (!permissions || permissions.length === 0) return true;

    try {
        if (browserAPI.permissions && browserAPI.permissions.request) {
            // MV3 chrome.permissions.request returns a Promise as well
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (await browserAPI.permissions.request({ permissions: permissions as any })) as boolean;
        }
    } catch (e) {
        console.error("Failed to request permission:", e);
    }
    return false;
};

/**
 * Check if the userScripts API is available and usable.
 * In Firefox, even if the API exists, we might need to request permission.
 */
export const isUserScriptsAvailable = async (): Promise<boolean> => {
    if (!browserAPI.userScripts) return false;

    const probeId = `shieldmonkey-permission-probe-${crypto.randomUUID()}`;
    try {
        const has = await browserAPI.permissions.contains({ permissions: ['userScripts'] });
        if (!has) return false;
        // Vivaldi allows getScripts() even while its separate user-script
        // switch is off. Registering is the operation needed to run scripts.
        await browserAPI.userScripts.register([{
            id: probeId,
            matches: ['https://shieldmonkey.invalid/*'],
            js: [{ code: 'void 0;' }]
        }]);
        return true;
    } catch (e) {
        console.warn("User scripts are unavailable:", e);
        return false;
    } finally {
        try {
            await browserAPI.userScripts.unregister({ ids: [probeId] });
        } catch {
            // Registration may have failed before the probe existed.
        }
    }
};

/**
 * Wrapper for userScripts.register
 */
export const registerUserScripts = async (scripts: chrome.userScripts.UserScript[]) => {
    if (!browserAPI.userScripts) throw new Error("userScripts API not available");
    return await browserAPI.userScripts.register(scripts);
};

/**
 * Wrapper for userScripts.unregister
 */
export const unregisterUserScripts = async (filter?: chrome.userScripts.ScriptFilter) => {
    if (!browserAPI.userScripts) return;
    return await browserAPI.userScripts.unregister(filter);
};

/**
 * Wrapper for userScripts.getScripts
 */
export const getUserScripts = async (filter?: chrome.userScripts.ScriptFilter): Promise<chrome.userScripts.UserScript[]> => {
    if (!browserAPI.userScripts) return [];
    return await browserAPI.userScripts.getScripts(filter);
};

/**
 * Wrapper for userScripts.configureWorld
 */
export const configureUserScriptsWorld = async (properties: chrome.userScripts.ConfigureWorldProperties) => {
    if (!browserAPI.userScripts) return;
    return await browserAPI.userScripts.configureWorld(properties);
};
