// --- CONFIGURATION ---
// IMPORTANT: Replace with your actual Gemini API Key
const API_KEY = "API_KEY";
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`;

// --- DOM ELEMENTS ---
const themeToggleBtn = document.getElementById('theme-toggle');
const summarizeHourBtn = document.getElementById('summarize-hour');
const summarizeDayBtn = document.getElementById('summarize-day');
const summarizeCustomBtn = document.getElementById('summarize-custom');
const refreshSummaryBtn = document.getElementById('refresh-summary');
const startTimeInput = document.getElementById('start-time');
const endTimeInput = document.getElementById('end-time');
const summaryResultDiv = document.getElementById('summary-result');
const chatTitleDiv = document.getElementById('chat-title');
const statusMessageDiv = document.getElementById('status-message');

// Store the last used filter type to enable the "Refresh" button
let lastFilterType = 'hour';

// --- THEME MANAGEMENT ---

/**
 * Toggles the theme between light and dark mode and saves the preference.
 */
function toggleTheme() {
    document.body.classList.toggle('dark-mode');
    const isDarkMode = document.body.classList.contains('dark-mode');
    themeToggleBtn.textContent = isDarkMode ? 'Light!' : 'dark'; // Update button icon
    chrome.storage.local.set({ theme: isDarkMode ? 'dark' : 'light' });
}

/**
 * Loads the saved theme from storage and applies it to the UI.
 */
async function applyInitialTheme() {
    const data = await chrome.storage.local.get('theme');
    if (data.theme === 'dark') {
        document.body.classList.add('dark-mode');
        themeToggleBtn.textContent = 'light';
    } else {
        // Light mode is the default, no class needed, just set the icon
        themeToggleBtn.textContent = 'dark';
    }
}

// --- EVENT LISTENERS ---
themeToggleBtn.addEventListener('click', toggleTheme);
summarizeHourBtn.addEventListener('click', () => handleSummarizeClick('hour'));
summarizeDayBtn.addEventListener('click', () => handleSummarizeClick('day'));
summarizeCustomBtn.addEventListener('click', () => handleSummarizeClick('custom'));
refreshSummaryBtn.addEventListener('click', () => handleSummarizeClick(lastFilterType, true));

// --- INITIALIZATION ---
// Apply the saved theme as soon as the popup script runs
applyInitialTheme();


// --- UI STATE MANAGEMENT ---
function setLoadingState(isLoading) {
    const buttons = [summarizeHourBtn, summarizeDayBtn, summarizeCustomBtn, refreshSummaryBtn];
    buttons.forEach(button => button.disabled = isLoading);
    statusMessageDiv.textContent = isLoading ? 'Processing...' : '';
}

// --- MAIN LOGIC ---

async function handleSummarizeClick(filterType, forceRefresh = false) {
    setLoadingState(true);
    lastFilterType = filterType; // Remember the last action for the refresh button
    summaryResultDiv.textContent = 'Starting process...';
    chatTitleDiv.textContent = '';

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url || !tab.url.startsWith("https://web.whatsapp.com/")) {
        summaryResultDiv.textContent = 'This extension only works on web.whatsapp.com.';
        setLoadingState(false);
        return;
    }
    
    try {
        // 1. Check for a cached summary unless a refresh is forced
        if (!forceRefresh) {
            // We need the chat name first to check the cache
            statusMessageDiv.textContent = 'Injecting script to get chat name...';
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
            const preliminaryResponse = await chrome.tabs.sendMessage(tab.id, { action: "getMessages" });
            const chatName = preliminaryResponse ? preliminaryResponse.chatName : null;

            if (chatName) {
                const storedSummary = await getStoredSummary(chatName, filterType);
                if (storedSummary) {
                    chatTitleDiv.textContent = `Summary for: ${chatName}`;
                    summaryResultDiv.textContent = storedSummary;
                    statusMessageDiv.textContent = 'Displayed cached summary.';
                    setLoadingState(false);
                    return; // Stop here if cache is found and used
                }
            }
        }

        // 2. If no cache or forceRefresh, proceed with full scrape and summary
        statusMessageDiv.textContent = 'Requesting messages from the page...';
        // The script might have already been injected, but injecting again is safe
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        const response = await chrome.tabs.sendMessage(tab.id, { action: "getMessages" });

        if (response && response.messages) {
            chatTitleDiv.textContent = `Summary for: ${response.chatName || 'Current Chat'}`;
            
            statusMessageDiv.textContent = `Found ${response.messages.length} total messages. Filtering...`;
            const filteredMessages = filterMessages(response.messages, filterType);

            if (filteredMessages.length === 0) {
                summaryResultDiv.textContent = 'No messages found in the selected time range.';
                statusMessageDiv.textContent = 'Check console for parsing errors if this is unexpected.';
                setLoadingState(false);
                return;
            }
            
            statusMessageDiv.textContent = `Summarizing ${filteredMessages.length} messages with Gemini...`;
            const chatText = filteredMessages.map(m => `${m.meta} ${m.text}`).join('\n');
            const summary = await getGeminiSummary(chatText);
            summaryResultDiv.textContent = summary;
            
            await storeSummary(response.chatName, filterType, summary);

        } else if (response && response.error) {
            summaryResultDiv.textContent = `Error: ${response.error}`;
        } else {
             summaryResultDiv.textContent = 'Failed to extract messages. Ensure a chat is open and visible.';
        }

    } catch (error) {
        summaryResultDiv.textContent = `An error occurred: ${error.message}.`;
        console.error("Error in handleSummarizeClick:", error);
    } finally {
        setLoadingState(false);
    }
}

/**
 * Parses metadata string to get a Date object.
 * Improved regex to be more flexible with date separators and time formats.
 */
function parseMetaAndGetDate(metaStr) {
    if (!metaStr) return null;
    // Handles formats like [11:30, 17/08/2025] or [11:30 AM, 8/17/2025] or [11:30, 17.08.2025]
    const match = metaStr.match(/\[(\d{1,2}:\d{2})\s*(am|pm)?\s*,\s*(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4})\]/i);
    if (!match) {
        console.warn(`Could not parse meta string: "${metaStr}"`);
        return null;
    }

    const [, timeStr, period, dayStr, monthStr, yearStr] = match;
    let [hours, minutes] = timeStr.split(':').map(Number);
    
    if (period) { // Adjust for 12-hour format if AM/PM is present
        const lowerPeriod = period.toLowerCase();
        if (lowerPeriod === 'pm' && hours < 12) hours += 12;
        if (lowerPeriod === 'am' && hours === 12) hours = 0; // Midnight case
    }

    // Assuming a DD/MM/YYYY format. For MM/DD/YYYY, swap day and month.
    const day = parseInt(dayStr, 10);
    const month = parseInt(monthStr, 10) - 1; // JS months are 0-indexed
    const year = parseInt(yearStr, 10);

    if (isNaN(day) || isNaN(month) || isNaN(year) || isNaN(hours) || isNaN(minutes)) return null;
    return new Date(year, month, day, hours, minutes, 0);
}


function filterMessages(messages, filterType) {
    const now = new Date();
    let startTime, endTime = now;
    if (filterType === 'hour') startTime = new Date(now.getTime() - 3600000);
    else if (filterType === 'day') startTime = new Date(now.getTime() - 86400000);
    else if (filterType === 'custom') {
        if (!startTimeInput.value || !endTimeInput.value) { alert('Please select a start and end time.'); return []; }
        startTime = new Date(startTimeInput.value);
        endTime = new Date(endTimeInput.value);
    }
    return messages.filter(message => {
        const messageDate = parseMetaAndGetDate(message.meta);
        return messageDate && messageDate >= startTime && messageDate <= endTime;
    });
}

async function getGeminiSummary(text) {
    const MAX_LENGTH = 15000;
    if (text.length > MAX_LENGTH) text = text.substring(text.length - MAX_LENGTH);
    const requestBody = { "contents": [{ "parts": [{ "text": `Summarize this WhatsApp chat concisely...\n\n${text}` }] }] };
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API Error (${response.status}): ${errorData.error.message}`);
        }
        const data = await response.json();
        return data.candidates[0].content.parts[0].text;
    } catch (error) {
        console.error("Gemini API call failed:", error);
        return `Error calling Gemini API: ${error.message}`;
    }
}

// --- STORAGE FUNCTIONS ---
async function storeSummary(chatName, filterType, summary) {
    if (!chatName) return;
    const key = `summary_${chatName}_${filterType}`;
    await chrome.storage.local.set({ [key]: { summary, timestamp: new Date().getTime() } });
}

async function getStoredSummary(chatName, filterType) {
    if (!chatName) return null;
    const key = `summary_${chatName}_${filterType}`;
    const result = await chrome.storage.local.get([key]);
    if (result[key]) {
        const { summary, timestamp } = result[key];
        const ageMinutes = (new Date().getTime() - timestamp) / 60000;
        if (ageMinutes < 10) { // Cache is still valid for 10 minutes
            const cachedTime = new Date(timestamp).toLocaleTimeString();
            return `(Cached at ${cachedTime})\n\n${summary}`;
        }
    }
    return null;
}