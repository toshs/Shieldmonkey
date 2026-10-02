import { initBridge } from '../host/bridge';

// Initialize bridge
initBridge();

// Set body styles
document.body.style.margin = '0';
document.body.style.padding = '0';
// Popup hosts size themselves from the page's contents. Percentage/viewport-based
// heights can therefore collapse to zero before a mobile host has sized the popup.
const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
if (isMobile) {
    // Vivaldi on Android does not display a popup that reaches the screen edge.
    document.body.style.width = `${Math.min(360, (screen.availWidth || screen.width || 360) - 24)}px`;
    document.body.style.height = `${Math.min(400, screen.availHeight || screen.height || 400)}px`;
} else {
    document.body.style.width = '420px';
    document.body.style.height = '600px';
}
document.body.style.overflow = 'hidden';

// Create iframe
const iframe = document.createElement('iframe');
const hash = window.location.hash || '#/popup';
iframe.src = chrome.runtime.getURL('src/sandbox/index.html') + hash;
iframe.style.width = '100%';
iframe.style.height = '100%';
iframe.style.border = 'none';
iframe.style.display = 'block'; // Prevent inline vertical-align scrollbar
document.body.appendChild(iframe);
