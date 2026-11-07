import { setupBadgeListeners } from './badge';
import { setupGMListener } from './gmRequestHandler';
import { setupNavigationListener } from './navigation';
import { checkUserScriptsPermission } from './permissions';
import { reloadAllScripts } from './scripts';
import { setupSecurityRules } from './security';

import { setupMessageListener } from './messageHandler';
import { setupAutoBackup } from './backup';

// Initialize userscripts environment
chrome.runtime.onInstalled.addListener(async () => {
  console.log("Background Service Worker v0.2.1-debug loaded");
  await reloadAllScripts().catch(error => console.error('Could not reload all scripts:', error));
  await checkUserScriptsPermission();
  await setupSecurityRules();
});

chrome.runtime.onStartup.addListener(() => {
  checkUserScriptsPermission();
});

// Setup all listeners
setupBadgeListeners();
setupGMListener();
setupNavigationListener();
setupMessageListener();
setupAutoBackup();


// Generic notification click handler
chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId) {
    chrome.runtime.openOptionsPage();
  }
});
