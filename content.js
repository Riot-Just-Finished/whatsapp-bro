/**
 * content.js (Revised for better scraping)
 * This script runs in the context of the WhatsApp Web page.
 * It is responsible for scraping messages from the DOM and sending them to the popup script.
 */

/**
 * Extracts all messages from the currently active chat window.
 * This version uses the `data-pre-plain-text` attribute, which is more stable
 * than class names, to find message bubbles.
 * @returns {object} An object containing the chatName and an array of messages.
 */
function scrapeMessages() {
    const messages = [];

    // This selector directly targets the container for each message bubble, which contains metadata.
    const messageElements = document.querySelectorAll('div[data-pre-plain-text]');

    messageElements.forEach(el => {
        // The metadata contains the full timestamp, date, and author.
        // Example: "[11:30, 17/08/2025] John Doe:"
        const metaText = el.getAttribute('data-pre-plain-text');

        // The actual message text is usually inside a nested span.
        // We look for a span with class 'selectable-text' inside the copyable-text container.
        const textElement = el.querySelector('.copyable-text span.selectable-text');

        // Ensure we only capture actual text messages, not empty bubbles or system messages.
        if (textElement && textElement.innerText) {
            messages.push({
                meta: metaText, // Send the whole metadata string for robust parsing
                text: textElement.innerText.trim()
            });
        }
    });

    // Extract the chat/group name from the header using a more stable test ID.
    const headerElement = document.querySelector('header span[data-testid="conversation-header-name"]');
    const chatName = headerElement ? headerElement.innerText : 'Unknown Chat';

    return { chatName, messages };
}

/**
 * Listens for messages from the popup script.
 * If the message listener is already defined, this will not add a second one.
 * This prevents errors when the script is re-injected.
 */
if (!chrome.runtime.onMessage.hasListeners()) {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === "getMessages") {
            const data = scrapeMessages();
            if (data.messages.length > 0) {
                sendResponse(data);
            } else {
                sendResponse({ error: "Could not find any messages. Please ensure the chat is visible." });
            }
        }
        // Return true to indicate that the response will be sent asynchronously.
        return true;
    });
}