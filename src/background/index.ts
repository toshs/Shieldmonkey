import { setupBadgeListeners } from './badge';
import { setupGMListener } from './gmRequestHandler';
import { setupNavigationListener } from './navigation';
import { checkUserScriptsPermission } from './permissions';
import { reloadAllScripts } from './scripts';
import { setupSecurityRules } from './security';

import { setupMessageListener } from './messageHandler';
import { setupAutoBackup } from './backup';

// Runs on every worker start, including unpacked reloads and re-enabling.
// Configure protection independently of userscript permission/registration.
void setupSecurityRules().catch(error => console.error('Protection rules failed:', error));

// Initialize userscripts environment
chrome.runtime.onInstalled.addListener(async () => {
  await reloadAllScripts().catch(error => console.error('Could not reload all scripts:', error));
  await checkUserScriptsPermission();
});

chrome.runtime.onStartup.addListener(() => {
  void reloadAllScripts().catch(error => console.error('Could not register scripts:', error));
  void checkUserScriptsPermission();
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
