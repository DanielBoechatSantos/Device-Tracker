import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { pino } from 'pino';
import { Boom } from '@hapi/boom';
import qrcodeTerminal from 'qrcode-terminal';
import { WhatsAppTracker } from './tracker.js';

const app = express();
app.use(cors());
app.use(express.static('public'));

const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

let sock: any;
let isWhatsAppConnected = false;
const trackers: Map<string, { tracker: WhatsAppTracker; platform: string }> = new Map();
const activityLogs: any[] = [];

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        markOnlineOnConnect: true,
    });

    sock.ev.on('connection.update', async (update: any) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('\n--- ESCANEIE O QR CODE ABAIXO ---');
            qrcodeTerminal.generate(qr, { small: true });
        }
        if (connection === 'close') {
            isWhatsAppConnected = false;
            const shouldReconnect = (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            isWhatsAppConnected = true;
            console.log('\n✅ WHATSAPP CONECTADO!');
            io.emit('connection-open');
        }
    });
    sock.ev.on('creds.update', saveCreds);
}

connectToWhatsApp();

io.on('connection', (socket) => {
    if (isWhatsAppConnected) socket.emit('connection-open');
    socket.emit('hydrate-logs', activityLogs);

    socket.on('add-contact', async (data: { number: string }) => {
        const cleanNumber = data.number.replace(/\D/g, '');
        const targetJid = cleanNumber + '@s.whatsapp.net';

        try {
            const results = await sock.onWhatsApp(targetJid);
            if (results?.[0]?.exists) {
                const tracker = new WhatsAppTracker(sock, results[0].jid);
                tracker.onUpdate = (updateData: any) => {
                    const state = updateData.devices?.[0]?.state || updateData.state;
                    const rtt = updateData.devices?.[0]?.rtt || updateData.rtt;
                    const logEntry = { timestamp: new Date().toLocaleTimeString(), jid: results[0].jid, state, rtt };
                    activityLogs.push(logEntry);
                    if (activityLogs.length > 100) activityLogs.shift();
                    io.emit('tracker-update', logEntry);
                };
                trackers.set(targetJid, { tracker, platform: 'whatsapp' });
                tracker.startTracking();
                socket.emit('contact-added', { jid: targetJid, number: cleanNumber });
            }
        } catch (err) {
            socket.emit('error', { message: 'Erro ao verificar contato.' });
        }
    });

    // NOVA FUNÇÃO: Parar Rastreamento
    socket.on('remove-contact', (data: { number: string }) => {
        const cleanNumber = data.number.replace(/\D/g, '');
        const targetJid = cleanNumber + '@s.whatsapp.net';
        const entry = trackers.get(targetJid);
        if (entry) {
            entry.tracker.stopTracking();
            trackers.delete(targetJid);
            console.log(`🛑 Rastreio parado para: ${cleanNumber}`);
            socket.emit('contact-removed', { number: cleanNumber });
        }
    });
});

httpServer.listen(3001);