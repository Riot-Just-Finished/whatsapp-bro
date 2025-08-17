// --- CONFIGURATION ---
// IMPORTANT: Replace with your actual Gemini API Key
const API_KEY = "AIzaSyBH57KFKL9P9T0mL6VOnGC6oebXStjrwWE";
// THE FIX IS ON THIS LINE: "generativelanguage" is now spelled correctly.
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`;

// --- DOM ELEMENTS ---
const summarizeHourBtn = document.getElementById('summarize-hour');
const summarizeDayBtn = document.getElementById('summarize-day');
const summarizeCustomBtn = document.getElementById('summarize-custom');
const startTimeInput = document.getElementById('start-time');
const endTimeInput = document.getElementById('end-time');
const summaryResultDiv = document.getElementById('summary-result');
const chatTitleDiv = document.getElementById('chat-title');

// --- EVENT LISTENERS ---
summarizeHourBtn.addEventListener('click', () => handleSummarizeClick('hour'));
summarizeDayBtn.addEventListener('click', () => handleSummarizeClick('day'));
summarizeCustomBtn.addEventListener('click', () => handleSummarizeClick('custom'));

// --- MAIN LOGIC ---

async function handleSummarizeClick(filterType) {
    summaryResultDiv.textContent = 'Starting process...';
    chatTitleDiv.textContent = '';
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab.url || !tab.url.startsWith("https://web.whatsapp.com/")) {
        summaryResultDiv.textContent = 'This extension only works on web.whatsapp.com.';
        return;
    }
    
    try {
        summaryResultDiv.textContent = 'Injecting script into WhatsApp Web...';
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        
        summaryResultDiv.textContent = 'Requesting messages from the page...';
        const response = await chrome.tabs.sendMessage(tab.id, { action: "getMessages" });

        if (response && response.messages) {
            chatTitleDiv.textContent = `Summary for: ${response.chatName || 'Current Chat'}`;
            
            const storedSummary = await getStoredSummary(response.chatName, filterType);
            if (storedSummary) {
                summaryResultDiv.textContent = storedSummary;
                return;
            }
            summaryResultDiv.textContent = `Found ${response.messages.length} total messages. Filtering by time...`;
            const filteredMessages = filterMessages(response.messages, filterType);

            if (filteredMessages.length === 0) {
                summaryResultDiv.textContent = 'No messages found in the selected time range. Check the extension console for parsing errors.';
                return;
            }
            summaryResultDiv.textContent = `Found ${filteredMessages.length} messages to summarize. Calling Gemini API...`;

            const chatText = filteredMessages.map(m => `${m.meta} ${m.text}`).join('\n');
            const summary = await getGeminiSummary(chatText);
            summaryResultDiv.textContent = summary;
            
            await storeSummary(response.chatName, filterType, summary);

        } else if (response && response.error) {
            summaryResultDiv.textContent = `Error: ${response.error}`;
        } else {
             summaryResultDiv.textContent = 'Failed to extract messages. Ensure a chat is open.';
        }

    } catch (error) {
        summaryResultDiv.textContent = `An error occurred: ${error.message}.`;
        console.error("Error in handleSummarizeClick:", error);
    }
}

function parseMetaAndGetDate(metaStr) {
    if (!metaStr) return null;
    const match = metaStr.match(/\[(\d{1,2}:\d{2})\s*(am|pm)?\s*,\s*(\d{1,2}\/\d{1,2}\/\d{4})\]/i);
    if (!match) {
        console.warn(`Could not parse meta string: "${metaStr}"`);
        return null;
    }
    const timeStr = match[1], period = match[2], dateStr = match[3];
    let [hours, minutes] = timeStr.split(':').map(Number);
    if (period) {
        const lowerPeriod = period.toLowerCase();
        if (lowerPeriod === 'pm' && hours < 12) hours += 12;
        if (lowerPeriod === 'am' && hours === 12) hours = 0;
    }
    const dateParts = dateStr.split('/').map(Number);
    const day = dateParts[0], month = dateParts[1] - 1, year = dateParts[2];
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
        if (ageMinutes < 10) {
            const cachedTime = new Date(timestamp).toLocaleTimeString();
            return `(Cached at ${cachedTime})\n\n${summary}`;
        }
    }
    return null;
}