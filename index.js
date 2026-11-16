
require("dotenv").config();

const path = require("path");
const fs = require("fs");
const axios = require("axios");

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

// Configuration
const WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const TIMEOUT = Number(process.env.MESSAGE_TIMEOUT_MS || 150000);

const SESSION_NAME =
    process.env.WHATSAPP_SESSION_NAME || "eocean-support";

if (!WEBHOOK_URL || !WEBHOOK_SECRET) {
    throw new Error(
        "N8N_WEBHOOK_URL and WEBHOOK_SECRET must be configured."
    );
}

if (!Number.isInteger(TIMEOUT) || TIMEOUT < 1000) {
    throw new Error("MESSAGE_TIMEOUT_MS must be at least 1000.");
}

if (!/^https?:\/\//i.test(WEBHOOK_URL)) {
    throw new Error("N8N_WEBHOOK_URL must be a valid HTTP/HTTPS URL.");
}

// Logging
const logDirectory = path.join(__dirname, "logs");

fs.mkdirSync(logDirectory, { recursive: true });

const logStream = fs.createWriteStream(
    path.join(logDirectory, "app.log"),
    { flags: "a" }
);

function log(level, message) {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message
    };

    const line = JSON.stringify(entry);

    console.log(line);
    logStream.write(line + "\n");
}

// Message protection
const processedMessages = new Map();
const activeMessages = new Set();

const MESSAGE_RETENTION = 24 * 60 * 60 * 1000;
const MAX_PROCESSED_MESSAGES = 5000;

function cleanupMessages() {
    const now = Date.now();

    for (const [id, timestamp] of processedMessages) {
        if (now - timestamp > MESSAGE_RETENTION) {
            processedMessages.delete(id);
        }
    }

    while (processedMessages.size > MAX_PROCESSED_MESSAGES) {
        const oldest = processedMessages.keys().next().value;
        processedMessages.delete(oldest);
    }
}

// WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: SESSION_NAME,
        dataPath: path.join(__dirname, "sessions")
    }),

    puppeteer: {
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: [
        "--no-sandbox",
        "--disable-setuid-sandbox"
    ]
}
});

// QR authentication
client.on("qr", (qr) => {
    console.log("\nScan this QR code using WhatsApp:\n");

    qrcode.generate(qr, { small: true });

    log("info", "WhatsApp QR code generated.");
});

client.on("authenticated", () => {
    log("info", "WhatsApp authenticated.");
});

client.on("auth_failure", (error) => {
    log("error", `WhatsApp authentication failed: ${error}`);
});

client.on("ready", () => {
    log("info", "WhatsApp client is ready.");
});

client.on("disconnected", (reason) => {
    log("error", `WhatsApp disconnected: ${reason}`);
});

client.on("change_state", (state) => {
    log("info", `WhatsApp state: ${state}`);
});

// Process incoming messages
async function handleIncomingMessage(message) {
    const sender = message.from;
    const messageId = message.id?._serialized;
    const body = (message.body || "").trim();
    const messageType = message.type;

    const unsupportedReply =
        "I can only understand text messages and voice notes. Please send your message in text or voice format so I can assist you.";

    // Ignore own messages, groups and status updates
    if (
        message.fromMe ||
        !sender ||
        !messageId ||
        sender.endsWith("@g.us") ||
        sender === "status@broadcast"
    ) {
        return;
    }

    // Prevent duplicate processing
    if (
        processedMessages.has(messageId) ||
        activeMessages.has(messageId)
    ) {
        log("info", "Duplicate message ignored.");
        return;
    }

    activeMessages.add(messageId);

    let chat;
    let typingInterval;

    try {
        log("info", `Incoming message received. Type: ${messageType}`);

        // Only normal text and voice notes are supported
        if (messageType !== "chat" && messageType !== "ptt") {
            await client.sendMessage(sender, unsupportedReply);

            processedMessages.set(messageId, Date.now());
            cleanupMessages();

            log("info", "Unsupported-message notice sent.");
            return;
        }

        let webhookPayload;

        // Handle voice notes
        if (messageType === "ptt") {
            log("info", "Downloading incoming voice note.");

            const media = await message.downloadMedia();

            if (!media || !media.data) {
                await client.sendMessage(
                    sender,
                    "I couldn't access your voice note. Please send it again, or type your message."
                );

                processedMessages.set(messageId, Date.now());
                cleanupMessages();

                return;
            }

            webhookPayload = {
                from: sender,
                type: "ptt",
                audio: media.data,
                messageId: messageId
            };

            log("info", "Voice note downloaded successfully.");
        }

        // Handle normal text messages
        if (messageType === "chat") {
            if (!body) {
                return;
            }

            webhookPayload = {
                from: sender,
                type: "chat",
                message: body,
                messageId: messageId
            };
        }

        // Get customer chat and show typing indicator
        chat = await message.getChat();

        await chat.sendStateTyping();

        // Refresh typing indicator while waiting for n8n
        typingInterval = setInterval(async () => {
            try {
                await chat.sendStateTyping();
            } catch (error) {
                log("warn", "Could not refresh typing indicator.");
            }
        }, 10000);

        // Send text or voice message to n8n
        const response = await axios.post(
            WEBHOOK_URL,
            webhookPayload,
            {
                timeout: TIMEOUT,

                headers: {
                    "Content-Type": "application/json",
                    "x-webhook-secret": WEBHOOK_SECRET
                }
            }
        );

        const data = response.data;

        if (!data || data.success === false) {
            throw new Error("n8n reported an unsuccessful response.");
        }

        if (
            typeof data.reply !== "string" ||
            !data.reply.trim()
        ) {
            throw new Error("n8n returned an empty or invalid reply.");
        }

        // Stop typing before sending the reply
        clearInterval(typingInterval);
        typingInterval = undefined;

        await chat.clearState();

        // Send AI-generated reply to customer
        await client.sendMessage(sender, data.reply.trim());

        processedMessages.set(messageId, Date.now());
        cleanupMessages();

        log("info", "Customer reply sent successfully.");

    } catch (error) {
        const status = error.response?.status || "none";

        log(
            "error",
            `Message processing failed. HTTP status: ${status}. Error: ${error.message}`
        );

    } finally {
        // Always stop typing, even if an error occurs
        if (typingInterval) {
            clearInterval(typingInterval);
        }

        if (chat) {
            try {
                await chat.clearState();
            } catch (error) {
                log("warn", "Could not clear WhatsApp typing indicator.");
            }
        }

        activeMessages.delete(messageId);
    }
}

// Listen for incoming WhatsApp messages
client.on("message", (message) => {
    handleIncomingMessage(message).catch((error) => {
        log("error", `Unexpected message handler error: ${error.message}`);
    });
});

// Start application
async function start() {
    try {
        log("info", "Starting Eocean WhatsApp Assistant.");

        await client.initialize();

    } catch (error) {
        log("error", `WhatsApp initialization failed: ${error.message}`);
        process.exitCode = 1;
    }
}

// Graceful shutdown
async function shutdown(signal) {
    log("info", `Shutdown requested: ${signal}`);

    try {
        await client.destroy();
    } catch (error) {
        log("error", `Shutdown error: ${error.message}`);
    }

    logStream.end();
    process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

start();
