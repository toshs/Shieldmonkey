import { notifyUrlChange } from './gmRequestHandler';
export function setupNavigationListener() {
    chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
        notifyUrlChange(details.tabId, details.frameId, details.url);
    });
}
