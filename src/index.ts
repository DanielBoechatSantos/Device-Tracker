const debugMode = process.argv.includes('--debug') || process.argv.includes('-d');
const originalConsoleLog = console.log;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);

// Suprime logs técnicos do Baileys para manter o terminal limpo
const shouldSuppressOutput = (message: string): boolean => {
    return message.includes('Closing session:') ||
           message.includes('SessionEntry') ||
           message.includes('_chains') ||
           message.includes('registrationId') ||
           message.includes('currentRatchet') ||
           message.includes('ephemeralKeyPair') ||
           message.includes('pendingPreKey') ||
           message.includes('indexInfo') ||
           message.includes('baseKey') ||
           message.includes('remoteIdentityKey') ||
           message.includes('lastRemoteEphemeralKey') ||
           message.includes('previousCounter') ||
           message.includes('rootKey') ||
           message.includes('signedKeyId') ||
           message.includes('preKeyId') ||
           message.includes('<Buffer');
};

if (!debugMode) {
    console.log = (...args: any[]) => {
        const message = String(args[0] || '');
        if (!shouldSuppressOutput(message)) {
            originalConsoleLog(...args);
        }
    };

    process.stdout.write = ((chunk: any, encoding?: any, callback?: any): boolean => {
        const message = String(chunk);
        if (shouldSuppressOutput(message)) {
            if (typeof encoding === 'function') encoding();
            else if (typeof callback === 'function') callback();
            return true;
        }
        return originalStdoutWrite(chunk, encoding, callback);
    }) as typeof process.stdout.write;
}

import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { pino } from 'pino';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import * as readline from 'readline';

import { WhatsAppTracker } from './tracker.js';

let currentTargetJid: string | null = null;
let currentTracker: WhatsAppTracker | null = null;

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        markOnlineOnConnect: true,
    });

    originalConsoleLog('🔌 Conectando ao WhatsApp...');

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            if (currentTracker) {
                currentTracker.stopTracking();
                currentTracker = null;
            }
            const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            originalConsoleLog('✅ Conectado ao WhatsApp');
            askForTarget(sock);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

const askForTarget = (sock: any) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('\nDigite o número do alvo (com código do país e DDD): ', async (number) => {
        const cleanNumber = number.replace(/\D/g, '');
        if (cleanNumber.length < 10) {
            originalConsoleLog('Número inválido.');
            rl.close();
            return askForTarget(sock);
        }
        const targetJid = cleanNumber + '@s.whatsapp.net';
        try {
            const results = await sock.onWhatsApp(targetJid);
            if (results?.[0]?.exists) {
                currentTargetJid = results[0].jid;
                currentTracker = new WhatsAppTracker(sock, results[0].jid, debugMode);
                currentTracker.startTracking();
                originalConsoleLog(`✅ Monitorando: ${results[0].jid}`);
                rl.close();
            } else {
                originalConsoleLog('❌ Número não registrado.');
                rl.close();
                askForTarget(sock);
            }
        } catch (err) {
            rl.close();
            askForTarget(sock);
        }
    });
};

connectToWhatsApp();